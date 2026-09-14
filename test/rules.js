'use strict';
/** 규칙 확인 — node test/rules.js */
const assert = require('assert');
const Q = require('../public/rules.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const cells = list => list.map(m => `${m.x},${m.y}`).sort().join(' ');

console.log('쿼리도 규칙');

t('처음 자리와 벽 수', () => {
  const g2 = Q.newGame(2);
  assert.deepStrictEqual(g2.pawns.map(p => [p.x, p.y, p.walls]), [[4, 8, 10], [4, 0, 10]]);
  const g4 = Q.newGame(4);
  assert.deepStrictEqual(g4.pawns.map(p => [p.x, p.y, p.walls]), [[4, 8, 5], [0, 4, 5], [4, 0, 5], [8, 4, 5]]);
  assert.strictEqual(Q.distance(g2, 0), 8);
});

t('기본 이동은 상하좌우 한 칸', () => {
  const g = Q.newGame(2);
  assert.strictEqual(cells(Q.pawnMoves(g, 0)), '3,8 4,7 5,8');
});

t('벽이 이동을 막는다', () => {
  const g = Q.newGame(2);
  assert.ok(!Q.apply(g, 0, { k: 'wall', x: 3, y: 7, o: 'h' }).error);   // (3,7)-(4,7) 과 아래 사이
  assert.strictEqual(cells(Q.pawnMoves(g, 0)), '3,8 5,8');
  assert.strictEqual(g.pawns[0].walls, 9);
  assert.strictEqual(g.turn, 1);
});

t('겹치는 벽 · 엇갈리는 벽은 안 된다', () => {
  const g = Q.newGame(2);
  Q.apply(g, 0, { k: 'wall', x: 3, y: 3, o: 'h' });
  assert.match(Q.apply(g, 1, { k: 'wall', x: 3, y: 3, o: 'v' }).error, /겹/);
  assert.match(Q.apply(g, 1, { k: 'wall', x: 4, y: 3, o: 'h' }).error, /겹/);
  assert.match(Q.apply(g, 1, { k: 'wall', x: 2, y: 3, o: 'h' }).error, /겹/);
  assert.ok(!Q.apply(g, 1, { k: 'wall', x: 5, y: 3, o: 'h' }).error);
  assert.ok(!Q.apply(g, 0, { k: 'wall', x: 3, y: 4, o: 'v' }).error);   // 세로는 한 줄 아래라 괜찮다
});

t('길을 완전히 막는 벽은 안 된다', () => {
  const g = Q.newGame(2);
  g.pawns[0].x = 0; g.pawns[0].y = 8;           // 왼쪽 아래 구석
  assert.ok(!Q.apply(g, 0, { k: 'wall', x: 0, y: 6, o: 'h' }).error);   // 위를 막고
  assert.strictEqual(Q.wallProblem(g, 1, 1, 7, 'v'), 'block');         // 오른쪽까지 막으면 갇힌다
  assert.match(Q.apply(g, 1, { k: 'wall', x: 1, y: 7, o: 'v' }).error, /길/);
  assert.strictEqual(Q.wallProblem(g, 1, 1, 6, 'v'), null);            // 한 칸 위로 비키면 된다
});

t('마주 보면 뛰어넘는다', () => {
  const g = Q.newGame(2);
  g.pawns[0].x = 4; g.pawns[0].y = 5;
  g.pawns[1].x = 4; g.pawns[1].y = 4;
  assert.strictEqual(cells(Q.pawnMoves(g, 0)), '3,5 4,3 4,6 5,5');
});

t('뒤가 벽이면 옆으로 비껴간다', () => {
  const g = Q.newGame(2);
  g.pawns[0].x = 4; g.pawns[0].y = 5;
  g.pawns[1].x = 4; g.pawns[1].y = 4;
  g.hw[4][3] = true;   // (4,3)-(4,4) 사이 막힘
  assert.strictEqual(cells(Q.pawnMoves(g, 0)), '3,4 3,5 4,6 5,4 5,5');
});

t('판 끝에서 마주 보면 옆으로', () => {
  const g = Q.newGame(2);
  g.pawns[0].x = 4; g.pawns[0].y = 1;
  g.pawns[1].x = 4; g.pawns[1].y = 0;
  assert.strictEqual(cells(Q.pawnMoves(g, 0)), '3,0 3,1 4,2 5,0 5,1');
});

t('결승선에 닿으면 이긴다', () => {
  const g = Q.newGame(2);
  g.pawns[0].x = 3; g.pawns[0].y = 1;
  const r = Q.apply(g, 0, { k: 'move', x: 3, y: 0 });
  assert.ok(r.won);
  assert.strictEqual(g.winner, 0);
  assert.ok(Q.apply(g, 1, { k: 'move', x: 4, y: 1 }).error);
});

t('차례가 아니면 못 둔다 · 벽이 없으면 못 세운다', () => {
  const g = Q.newGame(2);
  assert.ok(Q.apply(g, 1, { k: 'move', x: 4, y: 1 }).error);
  g.pawns[0].walls = 0;
  assert.match(Q.apply(g, 0, { k: 'wall', x: 0, y: 0, o: 'h' }).error, /남은 벽/);
});

t('4인 — 기권하면 건너뛰고, 한 명 남으면 승리', () => {
  const g = Q.newGame(4);
  Q.retire(g, 0);
  assert.strictEqual(g.turn, 1);
  Q.retire(g, 2);
  Q.apply(g, 1, { k: 'move', x: 1, y: 4 });
  assert.strictEqual(g.turn, 3);
  Q.retire(g, 3);
  assert.strictEqual(g.winner, 1);
});

t('화면 회전 — 네 번 돌리면 제자리, 벽 방향도 맞다', () => {
  for (let x = 0; x < 9; x++) for (let y = 0; y < 9; y++) {
    assert.deepStrictEqual(Q.rotCell(x, y, 4), { x, y });
  }
  // 왼쪽 자리(0,4) 를 반시계로 한 번 돌리면 아래(4,8)
  assert.deepStrictEqual(Q.rotCell(0, 4, 1), { x: 4, y: 8 });
  // 벽 (0,0,h): (0,0)(1,0) 과 (0,1)(1,1) 사이 → 반시계 90° 는 (0,7)(0,8) 과 (1,7)(1,8) 사이 세로벽 = (0,7,v)
  assert.deepStrictEqual(Q.rotWall(0, 0, 'h', 1), { x: 0, y: 7, o: 'v' });
  // 회전한 판에서도 같은 칸이 막혀야 한다
  const g = Q.newGame(2);
  g.hw[2][3] = true; g.vw[5][1] = true;
  const r = Q.newGame(2);
  for (const [m, o] of [[g.hw, 'h'], [g.vw, 'v']]) for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    if (!m[x][y]) continue;
    const w = Q.rotWall(x, y, o, 1);
    (w.o === 'h' ? r.hw : r.vw)[w.x][w.y] = true;
  }
  for (let x = 0; x < 9; x++) for (let y = 0; y < 9; y++) for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    const a = Q.rotCell(x, y, 1);
    const b = Q.rotCell(x + dx, y + dy, 1);
    if (x + dx < 0 || y + dy < 0 || x + dx > 8 || y + dy > 8) continue;
    assert.strictEqual(Q.canStep(g, x, y, dx, dy), Q.canStep(r, a.x, a.y, b.x - a.x, b.y - a.y), `${x},${y} ${dx},${dy}`);
  }
});

t('봇끼리 끝까지 둔다 (2인 · 4인, 모든 난이도)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const n of [2, 4]) for (const lv of ['easy', 'normal', 'hard']) {
    const g = Q.newGame(n);
    let guard = 0;
    while (g.winner < 0 && guard++ < 400) {
      const a = Q.botMove(g, g.turn, lv, rnd);
      const r = Q.apply(g, g.turn, a);
      assert.ok(!r.error, `${n}인 ${lv}: ${r.error} ${JSON.stringify(a)}`);
    }
    assert.ok(g.winner >= 0, `${n}인 ${lv} 판이 안 끝남 (${g.ply}수)`);
    console.log(`      ${n}인 ${lv}: ${g.ply}수, 벽 ${g.walls.length}개`);
  }
});

t('어려움 봇이 쉬움 봇을 이긴다 (10판 중 7판 이상)', () => {
  let seed = 11, win = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 10; k++) {
    const g = Q.newGame(2);
    const lv = k % 2 ? ['hard', 'easy'] : ['easy', 'hard'];
    let guard = 0;
    while (g.winner < 0 && guard++ < 400) Q.apply(g, g.turn, Q.botMove(g, g.turn, lv[g.turn], rnd));
    if (g.winner >= 0 && lv[g.winner] === 'hard') win++;
  }
  assert.ok(win >= 7, `어려움 ${win}/10`);
});

t('첫 화면 구경용 세 판이 규칙대로 끝난다', () => {
  for (const [k, line] of Q.DEMO_GAMES.entries()) {
    const g = Q.newGame(2);
    for (const m of line.split(' ')) {
      const a = m[0] === 'm' ? { k: 'move', x: +m[1], y: +m[2] } : { k: 'wall', o: m[0], x: +m[1], y: +m[2] };
      const r = Q.apply(g, g.turn, a);
      assert.ok(!r.error, `${k + 1}번째 판 ${m}: ${r.error}`);
    }
    assert.ok(g.winner >= 0, `${k + 1}번째 판이 끝나지 않음`);
  }
});

console.log(`\n${pass}개 통과`);
