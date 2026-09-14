'use strict';
/**
 * 쿼리도 — 방 관리와 판 진행.
 *  - 말 위치 · 벽 · 차례 · 타이머 · 봇은 전부 서버가 쥔다(권위 서버).
 *    화면은 "이 칸으로 갈래 / 여기 벽 세울래" 만 보내고, 맞는 수인지는 rules.js 로 서버가 정한다.
 *  - 통신 방식은 모른다. 소켓은 send(문자열) · close() · readyState 만 있으면 된다.
 *    Node 서버(server.js)와 Cloudflare(worker.js)가 이 파일을 똑같이 쓴다.
 */
const Q = require('./public/rules.js');

const MAX_PLAYERS = 4;
const TURN_LIMITS = [0, 30000, 60000, 120000];   // 0 = 무제한
const LEVELS = ['easy', 'normal', 'hard'];
const FAST = typeof process !== 'undefined' && !!process.env && process.env.QUORIDOR_FAST === '1';
const DC_GRACE = FAST ? 200 : 30_000;            // 끊긴 사람 차례에 대신 두기까지 (시간 제한이 없을 때)
const LOBBY_GRACE = FAST ? 300 : 20_000;         // 대기실에서 끊긴 자리를 비우기까지
// 말이 미끄러지는 애니메이션(0.45초)이 끝나고 한숨 돌린 뒤에 둔다 — 봇 수가 눈에 들어오게
const BOT_THINK = FAST ? [5, 15] : [900, 1700];

const BOT_NAMES = ['도토리', '솔방울', '호두', '밤톨'];
const LEVEL_NAME = { easy: '쉬움', normal: '보통', hard: '어려움' };

/* ─────────────────────────── 유틸 ─────────────────────────── */

const pick = a => a[Math.floor(Math.random() * a.length)];
const rnd = (min, max) => min + Math.random() * (max - min);
const clean = (s, max) => String(s == null ? '' : s)
  .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, max);
const token = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)),
  b => b.toString(16).padStart(2, '0')).join('');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ─────────────────────────── 방 ─────────────────────────── */

const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  let code;
  do code = Array.from({ length: 4 }, () => pick(alphabet.split(''))).join('');
  while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby',            // lobby | playing | over
    hostId: null,
    players: [],
    nextId: 1,
    cfg: { turnLimit: 60000, botLevel: 'normal' },

    g: null,                   // rules.js 판
    order: [],                 // 말 인덱스 → player id
    last: null,                // 방금 둔 수 (화면 애니메이션용)
    turnEndsAt: 0,
    winnerId: null,
    endWhy: null,              // goal | resign | left
    games: 0,

    timers: { turn: null, bot: null, dc: null, host: null },
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, { name, bot, level }) {
  const p = {
    id: room.nextId++,
    token: token(),
    name: name || `플레이어 ${room.nextId - 1}`,
    bot: !!bot,
    level: bot ? (LEVELS.includes(level) ? level : room.cfg.botLevel) : null,
    ws: null,
    connected: !!bot,
    wins: 0,
  };
  room.players.push(p);
  if (!p.bot && room.hostId == null) room.hostId = p.id;
  return p;
}

const playerOf = (room, id) => room.players.find(p => p.id === id) || null;
const pawnOf = (room, id) => room.order.indexOf(id);
const turnId = room => (room.g ? room.order[room.g.turn] : null);

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const p = room.players[i];
  clearTimeout(p.leaveT);
  // 판 중에 나가면 그 말은 판에서 빠진다
  if (room.phase === 'playing') retirePlayer(room, p, 'left');
  room.players.splice(i, 1);
  if (room.hostId === id) {
    const next = room.players.find(x => !x.bot && x.connected) || room.players.find(x => !x.bot);
    room.hostId = next ? next.id : null;
  }
  // 사람이 하나도 없으면 방을 닫는다 — 봇끼리 둘 이유가 없다
  if (!room.players.some(x => !x.bot)) {
    clearAll(room);
    rooms.delete(room.code);
  }
}

/* ─────────────────────────── 판 진행 ─────────────────────────── */

function startGame(room) {
  clearAll(room);
  const n = room.players.length;
  // 누가 먼저 둘지는 섞는다. 먼저 두는 쪽이 아래 자리(첫 말)다.
  room.order = shuffle(room.players.map(p => p.id));
  room.g = Q.newGame(n);
  room.phase = 'playing';
  room.last = null;
  room.winnerId = null;
  room.endWhy = null;
  room.games++;
  startTurn(room);
}

function startTurn(room) {
  const g = room.g;
  clearTimeout(room.timers.turn); clearTimeout(room.timers.bot); clearTimeout(room.timers.dc);
  room.timers.turn = room.timers.bot = room.timers.dc = null;
  if (room.phase !== 'playing' || g.winner >= 0) return;

  const p = playerOf(room, turnId(room));
  const limit = room.cfg.turnLimit;
  room.turnEndsAt = limit ? Date.now() + limit : 0;
  if (limit) room.timers.turn = setTimeout(() => autoMove(room, p, 'timeout'), limit);

  if (p && p.bot && !room.players.some(x => !x.bot && x.connected)) {
    // 지켜보는 사람이 없으면 봇도 쉰다 — 누가 돌아오면 attach 에서 다시 깨운다
  } else if (p && p.bot) {
    // 첫 수는 판이 그려질 시간을 조금 더 준다
    const wait = rnd(...BOT_THINK) + (g.ply === 0 && !FAST ? 900 : 0);
    room.timers.bot = setTimeout(() => {
      if (room.phase !== 'playing' || turnId(room) !== p.id) return;
      const a = Q.botMove(room.g, room.g.turn, p.level);
      act(room, p, a);
    }, wait);
  } else if (p && !p.connected && !limit) {
    room.timers.dc = setTimeout(() => autoMove(room, p, 'away'), DC_GRACE);
  }
  pushState(room);
}

/** 시간이 다 됐거나 자리를 비운 사람 대신 한 걸음 */
function autoMove(room, p, why) {
  if (!p || room.phase !== 'playing' || turnId(room) !== p.id) return;
  const a = Q.fallbackMove(room.g, room.g.turn);
  if (!a) { advanceStuck(room); return; }
  ev(room, { kind: why, by: p.id });
  act(room, p, a, why);
}

/** 갈 곳이 전혀 없는 말(사방이 말로 둘러싸임 등)은 차례를 넘긴다 */
function advanceStuck(room) {
  const g = room.g;
  const from = g.turn;
  for (let k = 1; k <= g.pawns.length; k++) {
    const j = (from + k) % g.pawns.length;
    if (!g.pawns[j].out) { g.turn = j; break; }
  }
  startTurn(room);
}

function act(room, p, a, auto) {
  const g = room.g;
  const i = pawnOf(room, p.id);
  const before = g.pawns[i] && { x: g.pawns[i].x, y: g.pawns[i].y };
  const jump = a && a.k === 'move' && Q.pawnMoves(g, i).some(m => m.x === a.x && m.y === a.y && m.jump);
  const r = Q.apply(g, i, a);
  if (r.error) {
    if (p.ws) send(p.ws, { t: 'err', msg: r.error });
    return false;
  }
  room.lastActive = Date.now();
  room.last = a.k === 'move'
    ? { k: 'move', by: p.id, from: before, to: { x: a.x, y: a.y }, jump, auto: auto || null, ply: g.ply }
    : { k: 'wall', by: p.id, x: a.x, y: a.y, o: a.o, auto: auto || null, ply: g.ply };
  if (r.won) return finish(room, p.id, 'goal');
  startTurn(room);
  return true;
}

function retirePlayer(room, p, why) {
  const g = room.g;
  const i = pawnOf(room, p.id);
  if (!g || i < 0 || g.pawns[i].out || g.winner >= 0) return;
  const wasTurn = g.turn === i;
  Q.retire(g, i);
  room.last = { k: 'retire', by: p.id, why, ply: g.ply };
  ev(room, { kind: why === 'left' ? 'left' : 'resign', by: p.id });
  if (g.winner >= 0) return finish(room, room.order[g.winner], why);
  // 남은 사람이 전부 봇이면 그 판은 의미가 없다 — 끝낸다
  const humansLeft = g.pawns.some((q, k) => !q.out && !(playerOf(room, room.order[k]) || {}).bot);
  if (!humansLeft) return finish(room, null, why);
  if (wasTurn) startTurn(room); else pushState(room);
}

function finish(room, winnerId, why) {
  clearTimeout(room.timers.turn); clearTimeout(room.timers.bot); clearTimeout(room.timers.dc);
  room.timers.turn = room.timers.bot = room.timers.dc = null;
  room.phase = 'over';
  room.winnerId = winnerId;
  room.endWhy = why;
  room.turnEndsAt = 0;
  const w = playerOf(room, winnerId);
  if (w) w.wins++;
  pushState(room);
}

/* ─────────────────────────── 보내기 ─────────────────────────── */

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) { /* 막 닫힌 소켓 */ }
}

function stateFor(room, me) {
  const g = room.g;
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    meId: me.id,
    hostId: room.hostId,
    cfg: room.cfg,
    players: room.players.map(p => {
      const i = pawnOf(room, p.id);
      const pw = g && i >= 0 ? g.pawns[i] : null;
      return {
        id: p.id, name: p.name, bot: p.bot, level: p.level, connected: p.connected, wins: p.wins,
        pawn: pw ? { i, seat: pw.seat, x: pw.x, y: pw.y, walls: pw.walls, out: pw.out } : null,
      };
    }),
    n: g ? g.n : 0,
    walls: g ? g.walls.map(w => ({ x: w.x, y: w.y, o: w.o, by: room.order[w.by], seat: g.pawns[w.by].seat })) : [],
    turn: room.phase === 'playing' ? turnId(room) : null,
    turnEndsAt: room.turnEndsAt,
    now: Date.now(),
    ply: g ? g.ply : 0,
    last: room.last,
    winnerId: room.winnerId,
    endWhy: room.endWhy,
    games: room.games,
  };
}

function pushState(room) {
  for (const p of room.players) if (p.ws) send(p.ws, stateFor(room, p));
}
function broadcast(room, obj) {
  for (const p of room.players) if (p.ws) send(p.ws, obj);
}
const ev = (room, obj) => broadcast(room, Object.assign({ t: 'ev' }, obj));

function clearAll(room) {
  for (const k of Object.keys(room.timers)) { clearTimeout(room.timers[k]); room.timers[k] = null; }
  for (const p of room.players) clearTimeout(p.leaveT);
}

function attach(room, p, ws) {
  if (ws.roomCode && (ws.roomCode !== room.code || ws.playerId !== p.id)) detach(ws);
  clearTimeout(p.leaveT);
  p.ws = ws; p.connected = true;
  ws.roomCode = room.code; ws.playerId = p.id;
  room.lastActive = Date.now();
  send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
  const t = playerOf(room, turnId(room));
  if (room.phase === 'playing' && t && t.bot && !room.timers.bot) { startTurn(room); return; }
  pushState(room);
}

function detach(ws) {
  const room = rooms.get(ws.roomCode);
  ws.roomCode = null;
  const id = ws.playerId;
  ws.playerId = null;
  if (!room) return;
  const p = playerOf(room, id);
  if (!p || p.ws !== ws) return;
  if (room.phase === 'lobby') removePlayer(room, p.id);
  else { p.ws = null; p.connected = false; }
  if (rooms.has(room.code)) pushState(room);
}

/* ─────────────────────────── 메시지 ─────────────────────────── */

function handle(ws, msg) {
  if (['create', 'join', 'resume', 'solo'].includes(msg.t) && ws.roomCode) detach(ws);
  switch (msg.t) {
    case 'create': {
      const r = createRoom();
      const p = addPlayer(r, { name: clean(msg.name, 12) || '플레이어 1' });
      attach(r, p, ws);
      return;
    }
    case 'solo': {
      // 혼자 하기 — 방을 만들고 봇을 앉혀 곧바로 시작한다
      const r = createRoom();
      const lv = LEVELS.includes(msg.level) ? msg.level : 'normal';
      r.cfg.botLevel = lv;
      r.cfg.turnLimit = 0;
      const p = addPlayer(r, { name: clean(msg.name, 12) || '나' });
      const n = msg.n === 4 ? 4 : 2;
      for (let k = 1; k < n; k++) addPlayer(r, { name: BOT_NAMES[k - 1], bot: true, level: lv });
      attach(r, p, ws);
      startGame(r);
      return;
    }
    case 'join': {
      const code = clean(msg.code, 8).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
      if (r.phase !== 'lobby') return send(ws, { t: 'err', msg: '이미 시작한 방이에요.' });
      if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
      const p = addPlayer(r, { name: clean(msg.name, 12) || `플레이어 ${r.players.length + 1}` });
      attach(r, p, ws);
      ev(r, { kind: 'joined', by: p.id });
      return;
    }
    case 'resume': {
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '방이 사라졌어요.', fatal: true });
      const p = r.players.find(x => !x.bot && x.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '자리를 찾을 수 없어요.', fatal: true });
      // 먼저 붙어 있던 소켓(복제한 탭 등)은 4001 로 닫는다 — 두 탭이 서로 밀어내며 끝없이 붙지 않게
      if (p.ws && p.ws !== ws) { send(p.ws, { t: 'moved' }); try { p.ws.close(4001, 'moved'); } catch (_) {} }
      attach(r, p, ws);
      if (r.phase === 'playing' && turnId(r) === p.id) { clearTimeout(r.timers.dc); r.timers.dc = null; }
      return;
    }
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const me = playerOf(room, ws.playerId);
  if (!me || me.ws !== ws) return;
  const isHost = room.hostId === me.id;
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'name':
      me.name = clean(msg.name, 12) || me.name;
      pushState(room);
      break;

    case 'cfg': {
      if (!isHost || room.phase === 'playing') return;
      if (TURN_LIMITS.includes(msg.turnLimit)) room.cfg.turnLimit = msg.turnLimit;
      if (LEVELS.includes(msg.botLevel)) {
        room.cfg.botLevel = msg.botLevel;
        for (const p of room.players) if (p.bot) p.level = msg.botLevel;
      }
      pushState(room);
      break;
    }

    case 'addBot': {
      if (!isHost || room.phase === 'playing') return;
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '자리가 없어요.' });
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `봇 ${room.players.length + 1}`;
      addPlayer(room, { name, bot: true });
      pushState(room);
      break;
    }

    case 'kick': {
      if (!isHost || room.phase === 'playing') return;
      const target = playerOf(room, msg.id);
      if (!target || target.id === room.hostId) return;
      if (target.ws) {
        send(target.ws, { t: 'err', msg: '방장이 내보냈어요.', fatal: true });
        target.ws.roomCode = null; target.ws.playerId = null;
      }
      removePlayer(room, target.id);
      pushState(room);
      break;
    }

    case 'start': {
      if (!isHost || room.phase === 'playing') return;
      const n = room.players.length;
      if (n !== 2 && n !== 4) {
        return send(ws, { t: 'err', msg: n < 2 ? '두 명은 있어야 시작할 수 있어요.' : '쿼리도는 2명 또는 4명이 해요. 봇을 넣거나 빼 주세요.' });
      }
      startGame(room);
      break;
    }

    case 'act': {
      if (room.phase !== 'playing' || turnId(room) !== me.id) return send(ws, { t: 'err', msg: '내 차례가 아니에요.' });
      const a = msg.a || {};
      if (a.k !== 'move' && a.k !== 'wall') return;
      act(room, me, { k: a.k, x: a.x | 0, y: a.y | 0, o: a.o === 'v' ? 'v' : 'h' });
      break;
    }

    case 'resign':
      if (room.phase !== 'playing') return;
      retirePlayer(room, me, 'resign');
      break;

    // 같은 방 사람끼리 하는 잡담. 판정에는 아무 영향이 없고 저장하지 않는다.
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const now = Date.now();
      if (now - (me.lastChat || 0) < 400) return;
      me.lastChat = now;
      broadcast(room, { t: 'chat', from: me.id, name: me.name, text });
      break;
    }
    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      // 판 중에 떠난 사람은 대기실 떠나기 예약을 걸어 둔다 — 유령 자리로 남지 않게
      for (const p of room.players) if (!p.bot && !p.connected) armLeave(room, p);
      const n = room.players.length;
      if (msg.now && (n === 2 || n === 4) && room.players.every(p => p.bot || p.connected)) {
        startGame(room);
        return;
      }
      clearAll(room);
      room.phase = 'lobby';
      room.g = null; room.order = []; room.last = null; room.winnerId = null; room.endWhy = null;
      pushState(room);
      break;
    }

    case 'leave':
      ws.roomCode = null; ws.playerId = null;
      me.ws = null; me.connected = false;
      removePlayer(room, me.id);
      send(ws, { t: 'left' });
      if (rooms.has(room.code)) pushState(room);
      break;
  }
}

function armLeave(room, p) {
  clearTimeout(p.leaveT);
  p.leaveT = setTimeout(() => {
    if (p.connected || !rooms.has(room.code)) return;
    if (room.phase === 'playing') return;         // 판 중이면 자리를 지킨다 — 돌아올 수 있다
    removePlayer(room, p.id);
    if (rooms.has(room.code)) pushState(room);
  }, LOBBY_GRACE);
}

function disconnect(ws, { keepSeat = false } = {}) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = playerOf(room, ws.playerId);
  if (!p || p.ws !== ws) return;
  p.connected = false; p.ws = null;
  room.lastActive = Date.now();

  if (room.hostId === p.id) {
    clearTimeout(room.timers.host);
    room.timers.host = setTimeout(() => {
      const h = playerOf(room, room.hostId);
      if (h && h.connected) return;
      const next = room.players.find(x => !x.bot && x.connected);
      if (next) { room.hostId = next.id; pushState(room); }
    }, LOBBY_GRACE);
  }

  if (room.phase === 'lobby') {
    if (!keepSeat) armLeave(room, p);
  } else if (room.phase === 'playing' && turnId(room) === p.id && !room.cfg.turnLimit) {
    clearTimeout(room.timers.dc);
    room.timers.dc = setTimeout(() => autoMove(room, p, 'away'), DC_GRACE);
  }
  pushState(room);
}

function sweepRooms(now = Date.now()) {
  for (const [code, room] of rooms) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    const seated = room.players.some(p => !p.bot);
    if (humans === 0 && now - room.lastActive > (seated ? 10 * 60_000 : 90_000)) {
      clearAll(room);
      rooms.delete(code);
    }
  }
}

/** 켜질 때 한 번 — 규칙 파일이 제대로 붙었는지 */
function selfCheck() {
  const g = Q.newGame(2);
  if (Q.distance(g, 0) !== 8 || Q.pawnMoves(g, 0).length !== 3) throw new Error('rules.js 가 이상해요');
}

module.exports = { rooms, handle, disconnect, sweepRooms, selfCheck, MAX_PLAYERS, LEVEL_NAME };
