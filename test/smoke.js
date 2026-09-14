'use strict';
/**
 * 떠 있는 서버에 붙어서 한 판의 뼈대를 확인한다 — 어느 서버든 주소만 주면 된다.
 *   node test/smoke.js http://127.0.0.1:8795                (node server.js)
 *   node test/smoke.js https://quoridor.41ways.workers.dev  (배포본)
 * 두 사람이 방을 만들고 · 들어가고 · 시작해서 말을 옮기고 · 벽을 세우고 · 새로고침(resume) · 기권까지.
 */
const assert = require('assert');
const WebSocket = require('ws');

const BASE = (process.argv[2] || 'http://127.0.0.1:8795').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
const tx = (ws, obj) => ws.send(JSON.stringify(obj));
async function waitFor(ws, pred, ms = 6000, what = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = ws.inbox.length - 1; i >= 0; i--) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(25);
  }
  throw new Error('기다리던 메시지가 오지 않음 ' + what + ': ' + JSON.stringify(ws.inbox.slice(-1)).slice(0, 300));
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

(async () => {
  console.log('쿼리도 연결 확인 → ' + BASE);
  let a, b, code, tokenA;

  await check('화면 파일이 나온다', async () => {
    const html = await fetch(BASE + '/').then(r => r.text());
    assert.ok(html.includes('쿼리도'), 'index.html 이 아님');
    for (const f of ['/style.css', '/rules.js', '/board.js', '/app.js']) {
      assert.strictEqual((await fetch(BASE + f)).status, 200, f);
    }
  });

  await check('상태 확인', async () => {
    const h = await fetch(BASE + '/healthz').then(r => r.json());
    assert.strictEqual(h.ok, true);
  });

  await check('방 만들기 · 들어가기 · 시작', async () => {
    a = await open(); b = await open();
    tx(a, { t: 'create', name: '시험가' });
    ({ code, token: tokenA } = await waitFor(a, m => m.t === 'joined'));
    tx(b, { t: 'join', code, name: '시험나' });
    await waitFor(a, m => m.t === 'state' && m.players.length === 2);
    tx(a, { t: 'cfg', turnLimit: 0 });
    tx(a, { t: 'start' });
    await waitFor(b, m => m.t === 'state' && m.phase === 'playing');
  });

  await check('번갈아 이동 · 벽', async () => {
    const s = await waitFor(a, m => m.t === 'state' && m.phase === 'playing');
    const [first, second] = s.turn === s.meId ? [a, b] : [b, a];
    tx(first, { t: 'act', a: { k: 'move', x: 4, y: 7 } });
    await waitFor(second, m => m.t === 'state' && m.ply === 1 && m.turn === m.meId);
    tx(second, { t: 'act', a: { k: 'wall', x: 3, y: 5, o: 'h' } });
    const s2 = await waitFor(first, m => m.t === 'state' && m.ply === 2);
    assert.strictEqual(s2.walls.length, 1);
  });

  await check('새로고침(resume)', async () => {
    a.close();
    await sleep(300);
    a = await open();
    tx(a, { t: 'resume', code, token: tokenA });
    const s = await waitFor(a, m => m.t === 'state' && m.ply === 2);
    assert.strictEqual(s.phase, 'playing');
  });

  await check('기권하면 끝', async () => {
    tx(a, { t: 'resign' });
    const s = await waitFor(b, m => m.t === 'state' && m.phase === 'over');
    assert.strictEqual(s.winnerId, s.meId);
  });

  await check('혼자 하기 — 봇이 둔다', async () => {
    const c = await open();
    tx(c, { t: 'solo', name: '시험', level: 'easy', n: 2 });
    const s = await waitFor(c, m => m.t === 'state' && m.phase === 'playing');
    if (s.turn === s.meId) tx(c, { t: 'act', a: { k: 'move', x: 4, y: 7 } });
    await waitFor(c, m => m.t === 'state' && m.ply >= 2 - (s.turn === s.meId ? 0 : 1), 8000, '봇 수');
    tx(c, { t: 'leave' });
    c.close();
  });

  for (const w of [a, b]) { try { tx(w, { t: 'leave' }); w.close(); } catch (_) {} }
  console.log(`\n${pass}개 통과${fail ? `, ${fail}개 실패` : ''}`);
  process.exit(fail ? 1 : 0);
})();
