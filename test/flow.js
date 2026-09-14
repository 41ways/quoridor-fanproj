'use strict';
/** 방 흐름 확인 — 가짜 소켓으로 game.js 를 직접 두드린다.  QUORIDOR_FAST=1 로 돈다. */
process.env.QUORIDOR_FAST = '1';
const assert = require('assert');
const Q = require('../public/rules.js');
const game = require('../game.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sock() {
  return {
    readyState: 1, inbox: [],
    send(s) { this.inbox.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    last(t) { for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].t === t) return this.inbox[i]; return null; },
  };
}
const st = ws => ws.last('state');

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }

(async () => {
  console.log('쿼리도 방 흐름');

  await t('방 만들기 · 들어가기 · 3명이면 시작 못 함 · 봇 넣어 4명', async () => {
    const a = sock(), b = sock(), c = sock();
    game.handle(a, { t: 'create', name: '가' });
    const code = a.last('joined').code;
    game.handle(b, { t: 'join', code, name: '나' });
    game.handle(c, { t: 'join', code: code.toLowerCase(), name: '다' });
    assert.strictEqual(st(a).players.length, 3);
    game.handle(a, { t: 'start' });
    assert.match(a.last('err').msg, /2명 또는 4명/);
    game.handle(b, { t: 'start' });                     // 방장이 아니면 무시
    assert.strictEqual(st(a).phase, 'lobby');
    game.handle(a, { t: 'addBot' });
    game.handle(a, { t: 'start' });
    const s = st(a);
    assert.strictEqual(s.phase, 'playing');
    assert.strictEqual(s.n, 4);
    assert.strictEqual(s.players.filter(p => p.pawn).length, 4);
    game.handle(a, { t: 'leave' }); game.handle(b, { t: 'leave' }); game.handle(c, { t: 'leave' });
  });

  await t('두 사람이 번갈아 두고, 틀린 수는 거절된다', async () => {
    const a = sock(), b = sock();
    game.handle(a, { t: 'create', name: '가' });
    const code = a.last('joined').code;
    game.handle(b, { t: 'join', code, name: '나' });
    game.handle(a, { t: 'cfg', turnLimit: 0 });
    game.handle(a, { t: 'start' });
    let s = st(a);
    const first = s.turn === s.meId ? a : b;
    const second = first === a ? b : a;
    const me = st(first).players.find(p => p.id === st(first).meId);
    assert.strictEqual(me.pawn.seat, 0);                // 먼저 두는 사람이 아래 자리
    game.handle(second, { t: 'act', a: { k: 'move', x: 4, y: 1 } });
    assert.match(second.last('err').msg, /차례/);
    game.handle(first, { t: 'act', a: { k: 'move', x: 4, y: 5 } });
    assert.match(first.last('err').msg, /갈 수 없/);
    game.handle(first, { t: 'act', a: { k: 'move', x: 4, y: 7 } });
    s = st(second);
    assert.strictEqual(s.turn, s.meId);
    assert.deepStrictEqual(s.last.to, { x: 4, y: 7 });
    game.handle(second, { t: 'act', a: { k: 'wall', x: 3, y: 6, o: 'h' } });
    s = st(first);
    assert.strictEqual(s.walls.length, 1);
    assert.strictEqual(s.walls[0].seat, 2);
    assert.strictEqual(s.players.find(p => p.id !== s.meId).pawn.walls, 9);
    // 기권하면 상대가 이긴다
    game.handle(first, { t: 'resign' });
    s = st(second);
    assert.strictEqual(s.phase, 'over');
    assert.strictEqual(s.winnerId, s.meId);
    assert.strictEqual(s.endWhy, 'resign');
    // 한 판 더 — 곧바로
    game.handle(a, { t: 'again', now: true });
    assert.strictEqual(st(b).phase, 'playing');
    game.handle(a, { t: 'leave' }); game.handle(b, { t: 'leave' });
  });

  await t('혼자 하기 — 봇과 끝까지 (사람 대신 시간 초과 자동 이동)', async () => {
    const a = sock();
    game.handle(a, { t: 'solo', name: '나', level: 'hard', n: 2 });
    game.handle(a, { t: 'cfg', turnLimit: 30000 });      // 판 중에는 설정을 못 바꾼다
    let s = st(a);
    assert.strictEqual(s.phase, 'playing');
    assert.strictEqual(s.cfg.turnLimit, 0);
    // 사람 차례엔 가장 짧은 길로 한 걸음씩
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      s = st(a);
      if (s.phase === 'over') break;
      if (s.turn === s.meId) {
        const g = Q.newGame(2);
        for (const p of s.players) Object.assign(g.pawns[p.pawn.i], { x: p.pawn.x, y: p.pawn.y, walls: p.pawn.walls });
        for (const w of s.walls) (w.o === 'h' ? g.hw : g.vw)[w.x][w.y] = true;
        g.turn = s.players.find(p => p.id === s.meId).pawn.i;
        game.handle(a, { t: 'act', a: Q.fallbackMove(g, g.turn) });
      }
      await sleep(10);
    }
    assert.strictEqual(st(a).phase, 'over', '판이 끝나지 않음');
    game.handle(a, { t: 'leave' });
  });

  await t('새로고침(resume) — 같은 자리로 돌아오고, 옛 탭은 moved', async () => {
    const a = sock(), b = sock();
    game.handle(a, { t: 'create', name: '가' });
    const { code, token } = a.last('joined');
    game.handle(b, { t: 'join', code, name: '나' });
    game.handle(a, { t: 'start' });
    const a2 = sock();
    game.handle(a2, { t: 'resume', code, token });
    assert.ok(a.last('moved'));
    assert.strictEqual(st(a2).meId, st(a).meId);
    game.disconnect(a);                                  // 옛 소켓이 닫혀도 자리는 그대로
    assert.ok(st(b).players.every(p => p.connected));
    game.handle(a2, { t: 'leave' });
    assert.strictEqual(st(b).phase, 'over');             // 둘 중 하나가 나가면 남은 사람이 이긴다
    game.handle(b, { t: 'leave' });
    assert.strictEqual(game.rooms.size, 0);
  });

  await t('대기실에서 끊기면 잠시 뒤 자리가 빈다', async () => {
    const a = sock(), b = sock();
    game.handle(a, { t: 'create', name: '가' });
    game.handle(b, { t: 'join', code: a.last('joined').code, name: '나' });
    game.disconnect(b);
    assert.strictEqual(st(a).players.length, 2);
    await sleep(400);
    assert.strictEqual(st(a).players.length, 1);
    game.handle(a, { t: 'leave' });
  });

  console.log(`\n${pass}개 통과`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
