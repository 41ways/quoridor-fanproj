/* 쿼리도 — 화면 */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const store = window.sessionStorage;
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MID = [{ x: 4, y: 8 }, { x: 0, y: 4 }, { x: 4, y: 0 }, { x: 8, y: 4 }];   // 자리별 출발선 가운데
  const GOAL_MID = [{ x: 4, y: 0 }, { x: 8, y: 4 }, { x: 4, y: 8 }, { x: 0, y: 4 }];
  const LEVEL = { easy: '쉬움', normal: '보통', hard: '어려움' };

  let ws = null, pingT = null, resting = false;
  let S = null;              // 서버가 보낸 마지막 상태
  let skew = 0;              // 서버 시계 - 내 시계
  let G = null;              // S 로 다시 세운 규칙 판 (갈 수 있는 칸 · 벽 검사용)
  let rot = 0;               // 내 말이 아래로 오게 돌리는 횟수
  let lastPly = -1, lastGames = -1, lastTurn = null;
  let pending = null;        // 폰에서 한 번 누른 벽 자리
  let showPaths = ls.get('paths') === '1';
  let overShown = false;

  /* ───────────────── 소리 ───────────────── */

  const Sound = (() => {
    let ctx = null;
    let on = ls.get('sound') !== '0';
    const ac = () => {
      if (!on) return null;
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; } }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    };
    function noise(c, dur) {
      const b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      const s = c.createBufferSource(); s.buffer = b; return s;
    }
    function tone(c, f, t0, dur, vol, type = 'sine', f2) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    }
    function knock(c, t0, freq, q, vol, dur) {
      const n = noise(c, dur), f = c.createBiquadFilter(), g = c.createGain();
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      g.gain.value = vol;
      n.connect(f).connect(g).connect(c.destination); n.start(t0);
    }
    const play = {
      move(c, t) { knock(c, t, 1500, 4, 1.4, 0.07); tone(c, 640, t, 0.07, 0.07, 'triangle', 420); },
      hop(c, t) { tone(c, 420, t, 0.16, 0.06, 'sine', 820); knock(c, t + 0.4, 1400, 4, 1.4, 0.07); },
      wall(c, t) { knock(c, t + 0.2, 520, 2, 2.2, 0.16); tone(c, 150, t + 0.2, 0.18, 0.2, 'sine', 90); knock(c, t + 0.29, 1800, 6, 0.5, 0.05); },
      turn(c, t) { tone(c, 784, t, 0.22, 0.05); tone(c, 1175, t + 0.09, 0.3, 0.045); },
      bad(c, t) { tone(c, 180, t, 0.12, 0.08, 'square', 140); },
      win(c, t) { [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.11, 0.42, 0.07, 'triangle')); },
      lose(c, t) { [392, 330, 262].forEach((f, i) => tone(c, f, t + i * 0.16, 0.4, 0.06, 'sine')); },
      pop(c, t) { tone(c, 900, t, 0.08, 0.05, 'sine', 1300); },
    };
    return {
      get on() { return on; },
      toggle() { on = !on; ls.set('sound', on ? '1' : '0'); if (on) this.fx('pop'); return on; },
      fx(name) { const c = ac(); if (c && play[name]) play[name](c, c.currentTime + 0.01); },
      unlock() { ac(); },
    };
  })();

  function paintSound() {
    for (const b of $$('[data-sound]')) {
      b.querySelector('use').setAttribute('href', Sound.on ? '#i-sound' : '#i-mute');
      b.setAttribute('aria-label', Sound.on ? '소리 끄기' : '소리 켜기');
    }
  }

  /* ───────────────── 테마 ───────────────── */

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    ls.set('theme', t);
    for (const b of $$('[data-theme-btn] use')) b.setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'dark' ? '#131217' : '#efe6d8';
  }

  /* ───────────────── 알림 ───────────────── */

  let toastT = null;
  function toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), ms);
  }

  function show(id) {
    for (const s of $$('.screen')) s.classList.toggle('on', s.id === id);
    demo.running(id === 'title');
    if (id !== 'game') { closeOverlay('#over'); $('#chat').classList.remove('on'); }
  }
  const current = () => ($('.screen.on') || {}).id;

  function openOverlay(sel) { $(sel).classList.add('on'); }
  function closeOverlay(sel) { $(sel).classList.remove('on'); }

  /* ───────────────── 연결 ───────────────── */

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect(onOpen) {
    if (ws && ws.readyState === 1) { onOpen && onOpen(); return; }
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch (_) {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = ws = new WebSocket(`${proto}://${location.host}/ws`);
    resting = false;

    ws.onopen = () => {
      if (sock !== ws) return;
      clearInterval(pingT);
      pingT = setInterval(() => send({ t: 'ping' }), 25_000);
      onOpen && onOpen();
    };
    ws.onmessage = e => {
      if (sock !== ws) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === 'moved' || m.t === 'idle') {
        sock.why = m.t;
        sock.onclose({ code: m.t === 'moved' ? 4001 : 4000 });
        ws = null;
        try { sock.close(); } catch (_) {}
        return;
      }
      handle(m);
    };
    ws.onclose = e => {
      if (sock !== ws && sock.why == null) return;
      clearInterval(pingT);
      const code = sock.why === 'moved' ? 4001 : sock.why === 'idle' ? 4000 : e.code;
      if (code === 4000 || code === 4001) {
        resting = true;
        toast(code === 4000
          ? '한동안 조작이 없어서 연결을 쉬고 있어요. 아무 곳이나 누르면 다시 붙어요.'
          : '다른 창에서 이 자리를 이어받았어요. 여기서 계속하려면 아무 곳이나 누르세요.', 1e9);
        return;
      }
      if (store.getItem('code') && store.getItem('token')) {
        toast('연결이 끊겼어요. 다시 붙는 중…');
        setTimeout(resume, 1200);
      } else if (current() !== 'title') {
        show('title');
      }
    };
  }
  const resume = () => connect(() => send({ t: 'resume', code: store.getItem('code'), token: store.getItem('token') }));

  document.addEventListener('pointerdown', () => {
    Sound.unlock();
    if (resting) { resting = false; $('#toast').classList.remove('on'); resume(); }
  }, true);

  function handle(m) {
    switch (m.t) {
      case 'joined':
        store.setItem('code', m.code);
        store.setItem('token', m.token);
        history.replaceState(null, '', '/?r=' + m.code);
        break;
      case 'state': render(m); break;
      case 'err':
        toast(m.msg);
        if (m.fatal) { forget(); show('title'); }
        else if (current() === 'game') Sound.fx('bad');
        break;
      case 'left': forget(); show('title'); break;
      case 'ev': onEvent(m); break;
      case 'chat': onChat(m); break;
      case 'emote': onEmote(m); break;
    }
  }

  function forget() {
    store.removeItem('code'); store.removeItem('token');
    S = null; lastPly = -1; lastGames = -1; overShown = false;
    history.replaceState(null, '', '/');
  }

  const nameOf = id => { const p = S && S.players.find(x => x.id === id); return p ? p.name : '누군가'; };

  function onEvent(m) {
    const n = nameOf(m.by);
    const text = {
      joined: `${n} 님이 들어왔어요`,
      timeout: `${n} 님 시간 초과 — 대신 한 칸 옮겼어요`,
      away: `${n} 님이 자리를 비워 대신 한 칸 옮겼어요`,
      resign: `${n} 님이 기권했어요`,
      left: `${n} 님이 나갔어요`,
    }[m.kind];
    if (!text) return;
    sysChat(text);
    if (m.kind !== 'joined' || current() === 'lobby') toast(text);
  }

  /* ───────────────── 그리기 ───────────────── */

  function render(s) {
    const prev = S;
    S = s;
    skew = s.now - Date.now();
    const me = s.players.find(p => p.id === s.meId);
    rot = me && me.pawn ? me.pawn.seat : 0;

    if (s.phase === 'lobby') {
      overShown = false;
      closeOverlay('#over');
      if (current() !== 'lobby') show('lobby');
      renderLobby(s);
      return;
    }
    if (current() !== 'game') show('game');
    if (s.games !== lastGames) { lastGames = s.games; lastPly = -1; overShown = false; closeOverlay('#over'); boardView.reset(); pending = null; }
    rebuild(s);
    renderGame(s, prev);
    if (s.phase === 'over' && !overShown) {
      overShown = true;
      setTimeout(() => { if (S && S.phase === 'over') showOver(S); }, s.last && s.last.k === 'move' ? 700 : 250);
    }
  }

  /* 대기실 */
  function renderLobby(s) {
    $('#lCode').textContent = s.code;
    const host = s.hostId === s.meId;
    const n = s.players.length;
    const seats = $('#seats');
    seats.innerHTML = '';
    for (let k = 0; k < 4; k++) {
      const p = s.players[k];
      const d = document.createElement('div');
      if (!p) {
        d.className = 'seat empty';
        d.innerHTML = host ? '<button data-add>+ 봇 넣기</button>' : '<span>빈자리</span>';
      } else {
        d.className = 'seat';
        d.style.animationDelay = k * 40 + 'ms';
        const tags = [p.id === s.hostId ? '방장' : '', p.id === s.meId ? '나' : '', p.bot ? `봇 · ${LEVEL[p.level] || ''}` : '', !p.connected && !p.bot ? '연결 끊김' : '', p.wins ? `${p.wins}승` : ''].filter(Boolean).join(' · ');
        d.innerHTML = `<span class="mini-pawn s${[0, 2, 1, 3][k]}">${p.bot ? '<span class="bot-tag">🤖</span>' : ''}</span>
          <div class="who"><div class="nm">${esc(p.name)}</div><div class="sub">${tags || '&nbsp;'}</div></div>
          ${host && p.id !== s.meId ? `<button class="kick" data-kick="${p.id}" aria-label="내보내기"><svg viewBox="0 0 24 24"><use href="#i-x"/></svg></button>` : ''}`;
      }
      seats.appendChild(d);
    }
    $('#seatHint').textContent = n === 1 ? '링크를 보내 친구를 부르거나 봇을 넣으세요. 자리와 색은 시작할 때 섞여요.'
      : n === 2 ? '1 : 1 준비 완료 — 벽은 한 사람에 10개씩'
      : n === 3 ? '쿼리도는 2명 또는 4명이 해요. 한 자리를 더 채우거나 비워 주세요.'
      : '4인전 준비 완료 — 벽은 한 사람에 5개씩';
    setSeg('#optTime', String(s.cfg.turnLimit), !host);
    setSeg('#optLevel', s.cfg.botLevel, !host);
    $('#bStart').hidden = !host;
    $('#bStart').disabled = !(n === 2 || n === 4);
    $('#waitHost').classList.toggle('on', !host);
  }

  function setSeg(sel, v, locked) {
    const seg = $(sel);
    seg.classList.toggle('locked', !!locked);
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
  }

  /* 서버 상태로 규칙 판을 다시 세운다 */
  function rebuild(s) {
    if (!s.n) { G = null; return; }
    const g = Q.newGame(s.n);
    for (const p of s.players) {
      if (!p.pawn) continue;
      Object.assign(g.pawns[p.pawn.i], { x: p.pawn.x, y: p.pawn.y, walls: p.pawn.walls, out: p.pawn.out });
    }
    // 판 중에 나가 버린 사람의 말은 players 에 없다 — 빠진 것으로 친다
    const present = new Set(s.players.filter(p => p.pawn).map(p => p.pawn.i));
    g.pawns.forEach((pw, i) => { if (!present.has(i)) pw.out = true; });
    for (const w of s.walls) { (w.o === 'h' ? g.hw : g.vw)[w.x][w.y] = true; g.walls.push(w); }
    const t = s.players.find(p => p.id === s.turn);
    g.turn = t && t.pawn ? t.pawn.i : -1;
    G = g;
  }

  const meP = () => S && S.players.find(p => p.id === S.meId);
  const myTurn = () => !!(S && S.phase === 'playing' && S.turn === S.meId && meP() && meP().pawn);
  const vCell = (c) => Q.rotCell(c.x, c.y, rot);            // 판 → 화면 (자리 번호만큼 반시계로)
  const lCell = (c) => Q.rotCell(c.x, c.y, -rot);           // 화면 → 판
  const vWall = (w) => Q.rotWall(w.x, w.y, w.o, rot);
  const lWall = (w) => Q.rotWall(w.x, w.y, w.o, -rot);
  function sideOf(c) {
    const v = vCell(c);
    return v.y === 0 ? 'top' : v.y === 8 ? 'bottom' : v.x === 0 ? 'left' : 'right';
  }

  function renderGame(s, prev) {
    const me = meP();
    const mine = myTurn();
    const turnP = s.players.find(p => p.id === s.turn);

    // 새로 둔 수
    let fresh = null;
    if (s.ply !== lastPly) {
      if (lastPly >= 0 && s.last) {
        if (s.last.k === 'wall') { fresh = `${vWall(s.last).x},${vWall(s.last).y},${vWall(s.last).o}`; Sound.fx('wall'); }
        else if (s.last.k === 'move') Sound.fx(s.last.jump ? 'hop' : 'move');
      }
      lastPly = s.ply;
      pending = null;
      boardView.clearGhost();
      hideConfirm();
    }
    if (mine && lastTurn !== s.turn + ':' + s.ply) {
      if (s.phase === 'playing') setTimeout(() => myTurn() && Sound.fx('turn'), 380);
      const pill = $('#turnPill'); pill.classList.remove('flash'); void pill.offsetWidth; pill.classList.add('flash');
    }
    lastTurn = s.turn + ':' + s.ply;

    const pawns = [], goals = [];
    for (const p of s.players) {
      if (!p.pawn || p.pawn.out) continue;
      const v = vCell(p.pawn);
      pawns.push({ key: p.id, seat: p.pawn.seat, x: v.x, y: v.y, active: p.id === s.turn, me: p.id === s.meId });
      goals.push({ seat: p.pawn.seat, side: sideOf(GOAL_MID[p.pawn.seat]) });
    }
    const walls = s.walls.map(w => Object.assign(vWall(w), { seat: w.seat }));
    const moves = mine && G ? Q.pawnMoves(G, G.turn).map(vCell) : [];
    const paths = [];
    if (G && (showPaths || s.phase === 'over')) {
      for (const p of s.players) {
        if (!p.pawn || p.pawn.out) continue;
        const cells = Q.shortestPath(G, p.pawn.i);
        if (cells) paths.push({ seat: p.pawn.seat, mine: p.id === s.meId, cells: cells.map(vCell) });
      }
    }
    let foot = null;
    if (s.last && s.last.k === 'move' && s.last.from) {
      const mover = s.players.find(p => p.id === s.last.by);
      if (mover && mover.pawn) foot = Object.assign(vCell(s.last.from), { seat: mover.pawn.seat });
    }

    boardView.render({ pawns, walls, goals, moves, mover: me && me.pawn ? me.pawn.seat : 0, paths, foot, fresh });

    const wrap = $('#boardWrap');
    wrap.classList.toggle('my-turn', mine);
    wrap.classList.toggle('watching', !mine);
    if (me && me.pawn) wrap.style.setProperty('--mc', `var(--s${me.pawn.seat})`);

    // 차례 알약
    const pill = $('#turnPill');
    pill.classList.toggle('mine', mine);
    if (s.phase === 'over') {
      pill.style.setProperty('--tc', 'var(--accent)');
      $('#turnText').textContent = '게임 끝 · 결과 보기';
    } else if (turnP && turnP.pawn) {
      pill.style.setProperty('--tc', `var(--s${turnP.pawn.seat})`);
      $('#turnText').textContent = mine ? '내 차례' : `${turnP.name} 차례`;
      pill.classList.toggle('thinking', !mine && !!turnP.bot);
    }

    renderChips(s);
    renderMe(s);
    const solo = s.players.filter(p => !p.bot).length === 1;
    $('#roomTag').textContent = `${solo ? '봇과 한 판' : '방 ' + s.code} · ${s.n === 4 ? '4인전' : '1 : 1'} · ${Math.floor(s.ply / Math.max(1, s.n)) + 1}번째 바퀴`;
  }

  function chipHTML(p, s, big) {
    const seat = p.pawn ? p.pawn.seat : 0;
    const d = G && p.pawn && !p.pawn.out ? Q.distance(G, p.pawn.i) : null;
    const total = Q.wallsFor(s.n);
    const left = p.pawn ? p.pawn.walls : 0;
    const sticks = big ? '' : `<span class="sticks" aria-label="남은 벽 ${left}개">${Array.from({ length: total }, (_, k) => `<i class="${k < left ? '' : 'used'}"></i>`).join('')}</span>`;
    const cls = ['pchip', 's' + seat];
    if (p.id === s.turn) cls.push('active');
    if (p.pawn && p.pawn.out) cls.push('out');
    if (!p.bot && !p.connected) cls.push('away');
    return `<div class="${cls.join(' ')}" data-pid="${p.id}">
      <span class="mini-pawn s${seat}">${p.bot ? '<span class="bot-tag">🤖</span>' : ''}</span>
      <div class="info">
        <div class="nm">${esc(p.name)}${p.wins ? ` <small style="color:var(--faint);font-weight:600">${p.wins}승</small>` : ''}</div>
        <div class="meta">${d != null ? `<span class="dist">${d}<small>칸</small></span>` : (p.pawn && p.pawn.out ? '<span>빠짐</span>' : '')}${sticks}${big ? `<span>벽 ${left}개</span>` : ''}</div>
      </div>
      <span class="timer"></span>
    </div>`;
  }

  function renderChips(s) {
    const others = s.players.filter(p => p.id !== s.meId && p.pawn);
    const wide = false;   // 넓은 화면은 CSS 가 오른쪽 기둥에 세로로 쌓는다
    const by = { top: [], left: [], right: [] };
    for (const p of others) {
      const side = sideOf(MID[p.pawn.seat]);
      (by[side] || by.top).push(p);
    }
    const top = wide ? by.top : [...by.left, ...by.top, ...by.right];
    setHTML('#railTop', top.map(p => chipHTML(p, s)).join(''));
    setHTML('#railLeft', wide ? by.left.map(p => chipHTML(p, s)).join('') : '');
    setHTML('#railRight', wide ? by.right.map(p => chipHTML(p, s)).join('') : '');
  }

  function renderMe(s) {
    const me = meP();
    if (!me || !me.pawn) { setHTML('#meCard', ''); setHTML('#stock', ''); return; }
    setHTML('#meCard', chipHTML(me, s, true));
    const total = Q.wallsFor(s.n);
    const stock = $('#stock');
    stock.style.setProperty('--mc', `var(--s${me.pawn.seat})`);
    setHTML('#stock', Array.from({ length: total }, (_, k) => `<i class="${k < me.pawn.walls ? '' : 'used'}"></i>`).join(''));
    stock.classList.toggle('armed', !!pending);
    const hint = $('#hint');
    hint.classList.remove('warn');
    if (s.phase === 'over') hint.textContent = '판이 끝났어요';
    else if (me.pawn.out) hint.textContent = '판에서 빠졌어요 — 구경 중';
    else if (!myTurn()) hint.textContent = '상대가 두는 중이에요';
    else if (pending) hint.textContent = '같은 자리를 한 번 더 누르거나 "여기에 세우기"를 누르세요';
    else hint.textContent = me.pawn.walls > 0 ? '빛나는 칸으로 옮기거나, 칸 사이 홈을 눌러 벽을 세우세요' : '벽을 다 썼어요 — 빛나는 칸으로 옮기세요';
  }

  // 같은 내용이면 DOM 을 건드리지 않는다 — 말풍선 · 애니메이션이 끊기지 않게
  function setHTML(sel, html) {
    const e = $(sel);
    if (e.__html === html) return;
    const bubbles = Array.from(e.querySelectorAll('.bubble, .say')).map(b => [b.parentElement.dataset.pid, b]);
    e.innerHTML = html;
    e.__html = html;
    for (const [pid, b] of bubbles) {
      const chip = e.querySelector(`[data-pid="${pid}"]`);
      if (chip) chip.appendChild(b);
    }
  }

  /* 타이머 막대 */
  (function tick() {
    requestAnimationFrame(tick);
    if (!S || S.phase !== 'playing' || !S.turnEndsAt) {
      for (const t of $$('.pchip .timer.on')) t.classList.remove('on');
      return;
    }
    const left = Math.max(0, S.turnEndsAt - (Date.now() + skew));
    const frac = left / (S.cfg.turnLimit || 1);
    for (const chip of $$(`.pchip[data-pid="${S.turn}"]`)) {
      const t = chip.querySelector('.timer');
      t.classList.add('on');
      t.style.transform = `scaleX(${frac})`;
      t.style.background = frac < 0.2 ? 'var(--accent)' : '';
    }
    if (myTurn() && left < 10000 && left > 0) {
      const h = $('#hint');
      if (!h.classList.contains('warn') || h.dataset.sec !== String(Math.ceil(left / 1000))) {
        h.classList.add('warn');
        h.dataset.sec = String(Math.ceil(left / 1000));
        h.textContent = `${Math.ceil(left / 1000)}초 남았어요`;
      }
    }
  })();

  /* ───────────────── 판 조작 ───────────────── */

  const boardView = {
    b: null,
    init() {
      this.b = new Board($('#board'), {
        prefer: cell => myTurn() && G && Q.pawnMoves(G, G.turn).some(m => { const v = vCell(m); return v.x === cell.x && v.y === cell.y; }),
        onHover: (t, cx, cy) => hover(t, cx, cy),
        onPick: (t, type, cx, cy) => pick(t, type, cx, cy),
      });
    },
    reset() { this.b.reset(); },
    render(v) { this.b.render(v); },
    clearGhost() { this.b.clearGhost(); tip(null); },
  };

  function wallCheck(t) {
    const w = lWall(t);
    return { w, why: Q.wallProblem(G, G.turn, w.x, w.y, w.o) };
  }

  function hover(t, cx, cy) {
    const b = boardView.b;
    if (!myTurn() || !t || pending) { if (!pending) { b.clearGhost(); tip(null); } return; }
    const seat = meP().pawn.seat;
    if (t.kind === 'cell') {
      b.ghostWall(null); tip(null);
      const ok = Q.pawnMoves(G, G.turn).some(m => { const v = vCell(m); return v.x === t.x && v.y === t.y; });
      b.ghostPawn(ok ? t : null, seat);
      return;
    }
    b.ghostPawn(null);
    const { why } = wallCheck(t);
    b.ghostWall(t, seat, why ? 'bad' : 'ok');
    tip(why ? Q.WALL_WHY[why] : null, cx, cy);
  }

  function pick(t, type, cx, cy) {
    const b = boardView.b;
    if (!S || S.phase !== 'playing') return;
    if (!myTurn()) {
      const turnP = S.players.find(p => p.id === S.turn);
      toast(turnP ? `지금은 ${turnP.name} 님 차례예요` : '잠시만요', 1400);
      return;
    }
    if (!t) { cancelPending(); return; }
    const seat = meP().pawn.seat;
    if (t.kind === 'cell') {
      const ok = Q.pawnMoves(G, G.turn).some(m => { const v = vCell(m); return v.x === t.x && v.y === t.y; });
      if (!ok) { if (pending) cancelPending(); return; }
      const l = lCell(t);
      cancelPending();
      b.clearGhost();
      send({ t: 'act', a: { k: 'move', x: l.x, y: l.y } });
      return;
    }
    const { w, why } = wallCheck(t);
    if (why) {
      Sound.fx('bad');
      b.ghostWall(t, seat, 'bad');
      tip(Q.WALL_WHY[why], cx, cy);
      setTimeout(() => { if (!pending) { b.ghostWall(null); tip(null); } else b.ghostWall(pending, seat, 'pending'); }, 900);
      return;
    }
    const same = pending && pending.x === t.x && pending.y === t.y && pending.o === t.o;
    if (type === 'mouse' || same) {
      cancelPending();
      b.clearGhost();
      send({ t: 'act', a: { k: 'wall', x: w.x, y: w.y, o: w.o } });
      return;
    }
    pending = t;
    b.ghostPawn(null);
    b.ghostWall(t, seat, 'pending');
    Sound.fx('pop');
    placeConfirm();
    renderMe(S);
  }

  // 확인 단추는 손가락 옆, 방금 누른 벽 바로 위에 띄운다 (위가 모자라면 아래)
  function placeConfirm() {
    const c = $('#confirm');
    const g = document.querySelector('#board .ghost-wall');
    if (!g) return;
    const wr = $('#boardWrap').getBoundingClientRect();
    const r = g.getBoundingClientRect();
    c.classList.add('on');
    const h = c.offsetHeight || 48, w = c.offsetWidth || 180;
    let top = r.top - wr.top - h - 14;
    if (top < 4) top = r.bottom - wr.top + 14;
    const left = Math.max(w / 2 + 4, Math.min(wr.width - w / 2 - 4, r.left - wr.left + r.width / 2));
    c.style.left = left + 'px';
    c.style.top = top + 'px';
  }

  function cancelPending() {
    if (!pending) return;
    pending = null;
    boardView.clearGhost();
    hideConfirm();
    if (S) renderMe(S);
  }
  function hideConfirm() { $('#confirm').classList.remove('on'); }

  function tip(text, cx, cy) {
    const e = $('#wallTip');
    if (!text) { e.classList.remove('on'); return; }
    const r = $('#boardWrap').getBoundingClientRect();
    e.textContent = text;
    e.style.left = (cx - r.left) + 'px';
    e.style.top = (cy - r.top) + 'px';
    e.classList.add('on');
  }

  $('#bConfirm').addEventListener('click', () => {
    if (!pending || !myTurn()) return cancelPending();
    const { w, why } = wallCheck(pending);
    if (why) { toast(Q.WALL_WHY[why]); return cancelPending(); }
    cancelPending();
    send({ t: 'act', a: { k: 'wall', x: w.x, y: w.y, o: w.o } });
  });
  $('#bCancel').addEventListener('click', cancelPending);

  $('#bPath').addEventListener('click', () => {
    showPaths = !showPaths;
    ls.set('paths', showPaths ? '1' : '0');
    $('#bPath').setAttribute('aria-pressed', String(showPaths));
    if (S && S.phase !== 'lobby') renderGame(S);
    toast(showPaths ? '가장 짧은 길을 점선으로 보여 줘요' : '길 보기를 껐어요', 1400);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      cancelPending();
      for (const o of ['#rules', '#menu']) closeOverlay(o);
      $('#chat').classList.remove('on');
    }
  });

  /* ───────────────── 끝 ───────────────── */

  function showOver(s) {
    const me = meP();
    const w = s.players.find(p => p.id === s.winnerId);
    const won = w && w.id === s.meId;
    const seat = w && w.pawn ? w.pawn.seat : 0;
    $('#overPawn').className = 'crown' + (w ? '' : ' lost');
    $('#overPawn').innerHTML = `<span class="mini-pawn ${w ? 's' + seat : 'neutral'}"></span>`;
    $('#overEyebrow').textContent = won ? '축하해요' : w ? '게임 끝' : '판이 멈췄어요';
    $('#overTitle').textContent = won ? '승리!' : w ? `${w.name} 승리` : '무승부';
    const moves = Math.ceil(s.ply / Math.max(1, s.n));
    $('#overSub').textContent = s.endWhy === 'resign' ? (won ? '상대가 기권했어요' : '기권으로 끝났어요')
      : s.endWhy === 'left' ? (won ? '상대가 나가서 이겼어요' : '사람이 모두 나갔어요')
      : won ? `${moves}수 만에 결승선에 닿았어요` : `${moves}수 만에 결승선에 닿았어요`;
    const total = Q.wallsFor(s.n);
    const rows = s.players.filter(p => p.pawn).sort((a, b) => (b.id === s.winnerId) - (a.id === s.winnerId) || a.pawn.i - b.pawn.i);
    $('#overStats').innerHTML = rows.map(p => {
      const d = G && !p.pawn.out ? Q.distance(G, p.pawn.i) : null;
      return `<li class="${p.id === s.winnerId ? 'win' : ''}" style="--wc:var(--s${p.pawn.seat})">
        <span class="mini-pawn sm s${p.pawn.seat}"></span>
        <span class="nm">${esc(p.name)}${p.id === s.meId ? ' <small style="color:var(--faint)">(나)</small>' : ''}</span>
        <span class="v">벽 ${total - p.pawn.walls}개 · ${p.id === s.winnerId ? '도착' : d != null ? `${d}칸 남음` : '빠짐'} · ${p.wins}승</span>
      </li>`;
    }).join('');
    const host = s.hostId === s.meId;
    $('#bAgain').hidden = !host;
    $('#bLobby').hidden = !host;
    $('#overWait').classList.toggle('on', !host);
    openOverlay('#over');
    if (won) { Sound.fx('win'); confetti(seat); } else if (me && me.pawn) Sound.fx('lose');
  }

  function confetti(seat) {
    const cv = $('#confetti');
    const c = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    const css = getComputedStyle(document.documentElement);
    const cols = [`--s${seat}`, `--s${seat}-hi`, '--wall-hi', '--wall', '--accent'].map(v => css.getPropertyValue(v).trim());
    const parts = Array.from({ length: 150 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.38,
      vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 5,
      w: 5 + Math.random() * 7, h: 9 + Math.random() * 12, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35,
      c: cols[(Math.random() * cols.length) | 0],
    }));
    const t0 = performance.now();
    (function frame(t) {
      const el = (t - t0) / 1000;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.42; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        c.save(); c.translate(p.x, p.y); c.rotate(p.r);
        c.globalAlpha = Math.max(0, 1 - el / 3.6);
        c.fillStyle = p.c;
        c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        c.restore();
      }
      if (el < 3.6) requestAnimationFrame(frame); else c.clearRect(0, 0, innerWidth, innerHeight);
    })(t0);
  }

  $('#bAgain').addEventListener('click', () => send({ t: 'again', now: true }));
  $('#bLobby').addEventListener('click', () => send({ t: 'again' }));
  $('#bView').addEventListener('click', () => closeOverlay('#over'));
  $('#turnPill').addEventListener('click', () => { if (S && S.phase === 'over') showOver(S); });

  /* ───────────────── 채팅 · 이모지 ───────────────── */

  let unread = 0;
  function sysChat(text) {
    const li = document.createElement('li');
    li.className = 'sys'; li.textContent = text;
    pushLog(li);
  }
  function pushLog(li) {
    const log = $('#chatLog');
    log.appendChild(li);
    while (log.children.length > 80) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  function onChat(m) {
    const li = document.createElement('li');
    const p = S && S.players.find(x => x.id === m.from);
    const seat = p && p.pawn ? p.pawn.seat : null;
    li.innerHTML = `<b style="color:${seat != null ? `var(--s${seat})` : 'var(--ink)'}">${esc(m.name)}</b>${esc(m.text)}`;
    pushLog(li);
    if (!$('#chat').classList.contains('on') && m.from !== (S && S.meId)) {
      unread++;
      const b = $('#chatBadge'); b.textContent = unread > 9 ? '9+' : unread; b.classList.add('on');
    }
    const chip = document.querySelector(`.pchip[data-pid="${m.from}"]`);
    if (chip) {
      const say = document.createElement('span');
      say.className = 'say'; say.textContent = m.text.length > 40 ? m.text.slice(0, 40) + '…' : m.text;
      chip.querySelectorAll('.say').forEach(x => x.remove());
      chip.appendChild(say);
      setTimeout(() => say.remove(), 3700);
    }
  }
  function onEmote(m) {
    const chip = document.querySelector(`.pchip[data-pid="${m.from}"]`);
    if (chip) {
      const b = document.createElement('span');
      b.className = 'bubble'; b.textContent = m.e;
      chip.appendChild(b);
      setTimeout(() => b.remove(), 1850);
    }
    const p = S && S.players.find(x => x.id === m.from);
    if (p && p.pawn && !p.pawn.out) { const v = vCell(p.pawn); boardView.b.floatAt(v.x, v.y, m.e); }
    Sound.fx('pop');
  }
  $('#emotes').addEventListener('click', e => {
    const b = e.target.closest('[data-e]');
    if (b) send({ t: 'emote', e: b.dataset.e });
  });
  $('#bChat').addEventListener('click', () => {
    $('#chat').classList.toggle('on');
    unread = 0; $('#chatBadge').classList.remove('on');
    if ($('#chat').classList.contains('on')) setTimeout(() => $('#chatInput').focus(), 50);
  });
  $('#bChatClose').addEventListener('click', () => $('#chat').classList.remove('on'));
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (!v) return;
    send({ t: 'chat', text: v });
    $('#chatInput').value = '';
  });

  /* ───────────────── 타이틀 · 대기실 버튼 ───────────────── */

  const myName = () => {
    const v = $('#name').value.trim().slice(0, 12);
    ls.set('name', v);
    return v;
  };

  function segPick(sel, fn) {
    $(sel).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || $(sel).classList.contains('locked')) return;
      for (const x of $(sel).querySelectorAll('button')) x.classList.toggle('on', x === b);
      fn(b.dataset.v);
    });
  }
  segPick('#soloLevel', v => ls.set('level', v));
  segPick('#soloN', v => ls.set('soloN', v));
  segPick('#optTime', v => send({ t: 'cfg', turnLimit: Number(v) }));
  segPick('#optLevel', v => send({ t: 'cfg', botLevel: v }));

  // 처음 화면 ↔ 고르기 화면
  function setup(on) {
    $('#intro').hidden = on;
    $('#setup').hidden = !on;
    $('#title').classList.toggle('setting', on);
    if (on) {
      if (matchMedia('(max-width: 860px)').matches) scrollTo({ top: 0 });
      Sound.fx('pop');
    }
  }
  $('#bBegin').addEventListener('click', () => { setup(true); if (!$('#name').value) setTimeout(() => $('#name').focus({ preventScroll: true }), 350); });
  $('#bBack').addEventListener('click', () => setup(false));

  $('#bSolo').addEventListener('click', () => {
    const level = ($('#soloLevel .on') || {}).dataset.v || 'normal';
    const n = Number(($('#soloN .on') || {}).dataset.v || 2);
    connect(() => send({ t: 'solo', name: myName() || '나', level, n }));
  });
  $('#bCreate').addEventListener('click', () => connect(() => send({ t: 'create', name: myName() })));
  const join = () => {
    const code = $('#joinCode').value.trim().toUpperCase();
    if (code.length !== 4) { toast('네 글자 방 코드를 적어 주세요'); $('#joinCode').focus(); return; }
    connect(() => send({ t: 'join', code, name: myName() }));
  };
  $('#bJoin').addEventListener('click', join);
  $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  $('#name').addEventListener('change', () => { if (S) send({ t: 'name', name: myName() }); });

  $('#seats').addEventListener('click', e => {
    if (e.target.closest('[data-add]')) send({ t: 'addBot' });
    const k = e.target.closest('[data-kick]');
    if (k) send({ t: 'kick', id: Number(k.dataset.kick) });
  });
  $('#bStart').addEventListener('click', () => send({ t: 'start' }));
  $('#bCopy').addEventListener('click', async () => {
    const url = `${location.origin}/?r=${S ? S.code : ''}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: '쿼리도 한 판 해요', text: `방 코드 ${S.code}`, url }); return; } catch (_) {}
    }
    try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요'); }
    catch (_) { toast(url, 5000); }
  });

  // 나가기 · 기권은 한 번 더 눌러야 한다
  function twice(btn, label, confirmLabel, fn) {
    if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.lastChild.textContent = ' ' + label; fn(); return; }
    btn.dataset.armed = '1';
    btn.lastChild.textContent = ' ' + confirmLabel;
    btn.style.color = 'var(--accent)';
    setTimeout(() => { btn.dataset.armed = ''; btn.lastChild.textContent = ' ' + label; btn.style.color = ''; }, 2600);
  }
  document.addEventListener('click', e => {
    const leave = e.target.closest('[data-leave]');
    if (leave) {
      const doLeave = () => { send({ t: 'leave' }); forget(); closeOverlay('#menu'); show('title'); };
      if (leave.classList.contains('sheet-item') && S && S.phase === 'playing') twice(leave, '방 나가기', '한 번 더 누르면 나가요', doLeave);
      else doLeave();
      return;
    }
    if (e.target.closest('[data-rules]')) { closeOverlay('#menu'); openRules(); return; }
    if (e.target.closest('[data-menu]')) { $('#bResign').hidden = !(S && S.phase === 'playing' && meP() && meP().pawn && !meP().pawn.out); openOverlay('#menu'); return; }
    if (e.target.closest('[data-close]')) { e.target.closest('.overlay').classList.remove('on'); return; }
    if (e.target.closest('[data-sound]')) { Sound.toggle(); paintSound(); return; }
    if (e.target.closest('[data-theme-btn]')) { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
    if (e.target.classList && e.target.classList.contains('overlay') && e.target.id !== 'over') e.target.classList.remove('on');
  });
  $('#bResign').addEventListener('click', e => twice(e.currentTarget, '기권하기', '한 번 더 누르면 기권해요', () => { send({ t: 'resign' }); closeOverlay('#menu'); }));

  /* ───────────────── 규칙 그림 ───────────────── */

  let lessonsDrawn = false;
  function openRules() {
    openOverlay('#rules');
    if (lessonsDrawn) return;
    lessonsDrawn = true;
    const P = (seat, x, y, extra) => Object.assign({ key: seat + 'p', seat, x, y }, extra);
    const crops = { move: [2, 3, 5, 5], wall: [2, 3, 5, 5], jump: [2, 2, 5, 5] };
    const mk = (name, v) => new Board(document.querySelector(`[data-lesson="${name}"]`), { mini: true, crop: crops[name] }).render(v);
    const g = Q.newGame(2);
    mk('goal', {
      pawns: [P(0, 4, 8, { active: true }), P(2, 4, 0)],
      goals: [{ seat: 0, side: 'top' }, { seat: 2, side: 'bottom' }],
      paths: [{ seat: 0, mine: true, cells: Q.shortestPath(g, 0) }],
    });
    mk('move', {
      pawns: [P(0, 4, 5, { active: true })],
      goals: [{ seat: 0, side: 'top' }],
      moves: [{ x: 4, y: 4 }, { x: 3, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 6 }], mover: 0,
    });
    const gw = Q.newGame(2);
    gw.pawns[0].y = 6;
    for (const w of [{ x: 3, y: 4, o: 'h' }, { x: 5, y: 4, o: 'h' }, { x: 2, y: 3, o: 'v' }]) { (w.o === 'h' ? gw.hw : gw.vw)[w.x][w.y] = true; }
    mk('wall', {
      pawns: [P(0, 4, 6, { active: true }), P(2, 4, 1)],
      walls: [{ x: 3, y: 4, o: 'h', seat: 2 }, { x: 5, y: 4, o: 'h', seat: 2 }, { x: 2, y: 3, o: 'v', seat: 0 }],
      goals: [{ seat: 0, side: 'top' }],
      paths: [{ seat: 0, mine: true, cells: Q.shortestPath(gw, 0) }],
    });
    mk('jump', {
      pawns: [P(0, 4, 5, { active: true }), P(2, 4, 4)],
      walls: [{ x: 3, y: 3, o: 'h', seat: 2 }],
      goals: [{ seat: 0, side: 'top' }],
      moves: [{ x: 3, y: 4 }, { x: 5, y: 4 }, { x: 3, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 6 }], mover: 0,
    });
  }

  /* ───────────────── 타이틀의 구경용 판 ───────────────── */

  // 봇끼리 미리 둬 둔 세 판을 차례로 되풀이한다 — 매번 새로 두면 판이 들쭉날쭉해서
  // m<x><y> 이동, h/v<x><y> 벽.  test/rules.js 가 세 판 모두 규칙대로 끝나는지 확인한다.
  const DEMO_GAMES = Q.DEMO_GAMES;

  const demo = (() => {
    let b = null, g = null, timer = null, on = false, game = -1, moves = [], at = 0;
    function reset() {
      game = (game + 1) % DEMO_GAMES.length;
      moves = DEMO_GAMES[game].split(' ');
      at = 0;
      g = Q.newGame(2);
      if (b) b.reset(); else b = new Board($('#demo'));
      draw();
    }
    function draw(fresh) {
      const ply = $('#demoPly'); if (ply) ply.textContent = g.ply;
      const walls = g.walls.map(w => ({ x: w.x, y: w.y, o: w.o, seat: g.pawns[w.by].seat }));
      b.render({
        pawns: g.pawns.map((p, i) => ({ key: i, seat: p.seat, x: p.x, y: p.y, active: g.winner < 0 && g.turn === i })),
        walls, fresh,
        goals: [{ seat: 0, side: 'top' }, { seat: 2, side: 'bottom' }],
      });
    }
    function step() {
      if (!on) return;
      if (g.winner >= 0 || at >= moves.length) { timer = setTimeout(() => { reset(); timer = setTimeout(step, 1200); }, 2600); return; }
      const m = moves[at++];
      const a = m[0] === 'm' ? { k: 'move', x: +m[1], y: +m[2] } : { k: 'wall', o: m[0], x: +m[1], y: +m[2] };
      Q.apply(g, g.turn, a);
      draw(a.k === 'wall' ? `${a.x},${a.y},${a.o}` : null);
      timer = setTimeout(step, 1150);
    }
    return {
      running(v) {
        if (v === on) return;
        on = v;
        clearTimeout(timer);
        if (on) { if (!g) reset(); timer = setTimeout(step, 900); }
      },
    };
  })();

  /* ───────────────── 시작 ───────────────── */

  setTheme(document.documentElement.dataset.theme || 'light');
  document.documentElement.style.setProperty('--grain-img', `url(${Board.grain()})`);
  paintSound();
  $('#bPath').setAttribute('aria-pressed', String(showPaths));
  $('#name').value = ls.get('name') || '';
  const lv = ls.get('level'); if (lv) setSeg('#soloLevel', lv);
  const sn = ls.get('soloN'); if (sn) setSeg('#soloN', sn);
  boardView.init();

  const params = new URLSearchParams(location.search);
  const invite = (params.get('r') || '').toUpperCase().slice(0, 4);
  if (store.getItem('code') && store.getItem('token') && (!invite || invite === store.getItem('code'))) {
    resume();
    show('title');
  } else {
    if (invite) {
      forget();
      setup(true);
      $('#joinCode').value = invite;
      history.replaceState(null, '', '/?r=' + invite);
      setTimeout(() => { toast(`방 ${invite} 초대장 — 이름을 적고 들어가기를 누르세요`, 3500); ($('#name').value ? $('#bJoin') : $('#name')).focus(); }, 400);
    }
    show('title');
  }
})();
