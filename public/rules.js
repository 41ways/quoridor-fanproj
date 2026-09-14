/**
 * 쿼리도 — 판 규칙과 봇.
 *
 * 서버(game.js)와 화면(app.js)이 이 파일 하나를 똑같이 쓴다.
 * 서버는 수가 맞는지 판정하고, 화면은 "갈 수 있는 칸 · 세울 수 있는 벽"을 미리 보여 주는 데 쓴다.
 *
 * 좌표
 *  - 칸은 (x, y), 0..8. y=0 이 위, y=8 이 아래.
 *  - 벽은 칸 네 개가 만나는 교차점 (x, y), 0..7 에 가운데를 두고 두 칸 길이로 선다.
 *      h: (x,y)-(x+1,y) 두 칸과 그 아래 두 칸 사이를 막는다
 *      v: (x,y)-(x,y+1) 두 칸과 그 오른쪽 두 칸 사이를 막는다
 */
(function (root) {
  'use strict';

  const N = 9;
  const G = N - 1;   // 교차점 한 변 개수

  // 자리 — 아래 · 왼쪽 · 위 · 오른쪽. 도는 순서도 이 순서(시계 방향)다.
  const SEATS = [
    { key: 'bottom', x: 4, y: 8, goal: { axis: 'y', v: 0 } },
    { key: 'left',   x: 0, y: 4, goal: { axis: 'x', v: 8 } },
    { key: 'top',    x: 4, y: 0, goal: { axis: 'y', v: 8 } },
    { key: 'right',  x: 8, y: 4, goal: { axis: 'x', v: 0 } },
  ];
  const seatsFor = n => (n === 2 ? [0, 2] : [0, 1, 2, 3]);
  const wallsFor = n => (n === 2 ? 10 : 5);

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  /* ─────────────────────────── 판 ─────────────────────────── */

  function grid() { return Array.from({ length: G }, () => new Array(G).fill(false)); }

  /** n 명(2 또는 4)으로 새 판 */
  function newGame(n) {
    if (n !== 2 && n !== 4) throw new Error('쿼리도는 2명 또는 4명');
    const walls = wallsFor(n);
    return {
      n,
      pawns: seatsFor(n).map(s => ({ seat: s, x: SEATS[s].x, y: SEATS[s].y, walls, out: false })),
      walls: [],          // { x, y, o, by }
      hw: grid(), vw: grid(),
      turn: 0,            // pawns 인덱스
      winner: -1,
      ply: 0,
    };
  }

  function clone(g) {
    return {
      n: g.n,
      pawns: g.pawns.map(p => Object.assign({}, p)),
      walls: g.walls.slice(),
      hw: g.hw.map(r => r.slice()), vw: g.vw.map(r => r.slice()),
      turn: g.turn, winner: g.winner, ply: g.ply,
    };
  }

  const inside = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

  /** (x,y) 에서 (dx,dy) 한 칸 — 판 밖이거나 벽에 막히면 false */
  function canStep(g, x, y, dx, dy) {
    const nx = x + dx, ny = y + dy;
    if (!inside(nx, ny)) return false;
    if (dy !== 0) {
      const wy = dy > 0 ? y : y - 1;
      if (x < G && g.hw[x][wy]) return false;
      if (x > 0 && g.hw[x - 1][wy]) return false;
    } else {
      const wx = dx > 0 ? x : x - 1;
      if (y < G && g.vw[wx][y]) return false;
      if (y > 0 && g.vw[wx][y - 1]) return false;
    }
    return true;
  }

  function pawnAt(g, x, y) {
    for (let i = 0; i < g.pawns.length; i++) {
      const p = g.pawns[i];
      if (!p.out && p.x === x && p.y === y) return i;
    }
    return -1;
  }

  const atGoal = (seat, x, y) => {
    const gl = SEATS[seat].goal;
    return (gl.axis === 'y' ? y : x) === gl.v;
  };

  /** i 번 말이 갈 수 있는 칸들 — 마주 보면 뛰어넘고, 뒤가 막히면 옆으로 비껴간다 */
  function pawnMoves(g, i) {
    const p = g.pawns[i];
    const out = [];
    const seen = new Set();
    const add = (x, y, jump) => {
      const k = x * N + y;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ x, y, jump });
    };
    for (const [dx, dy] of DIRS) {
      if (!canStep(g, p.x, p.y, dx, dy)) continue;
      const nx = p.x + dx, ny = p.y + dy;
      if (pawnAt(g, nx, ny) < 0) { add(nx, ny, false); continue; }
      // 바로 앞에 말이 있다
      if (canStep(g, nx, ny, dx, dy) && pawnAt(g, nx + dx, ny + dy) < 0) {
        add(nx + dx, ny + dy, true);
        continue;
      }
      // 뒤가 벽 · 판 끝 · 다른 말로 막혔다 — 옆으로
      for (const [px, py] of [[dy, dx], [-dy, -dx]]) {
        if (canStep(g, nx, ny, px, py) && pawnAt(g, nx + px, ny + py) < 0) add(nx + px, ny + py, true);
      }
    }
    return out;
  }

  /** 말들은 무시하고 벽만 따져서, 결승선까지 가장 짧은 거리. 길이 없으면 -1 */
  function distance(g, i) {
    const p = g.pawns[i];
    return bfs(g, p.x, p.y, p.seat).d;
  }

  /** 결승선까지 가장 짧은 길 (지금 칸 포함). 길이 없으면 null */
  function shortestPath(g, i) {
    const p = g.pawns[i];
    const r = bfs(g, p.x, p.y, p.seat, true);
    return r.path;
  }

  function bfs(g, sx, sy, seat, wantPath) {
    const prev = new Int16Array(N * N).fill(-2);
    const q = new Int16Array(N * N);
    let h = 0, t = 0;
    const s = sx * N + sy;
    prev[s] = -1;
    q[t++] = s;
    const dist = new Int16Array(N * N);
    // 목표 방향을 먼저 보면 같은 거리 중에서도 곧게 뻗은 길이 나온다(점선이 덜 꺾인다)
    const gl = SEATS[seat].goal;
    const order = gl.axis === 'y'
      ? (gl.v === 0 ? [[0, -1], [-1, 0], [1, 0], [0, 1]] : [[0, 1], [-1, 0], [1, 0], [0, -1]])
      : (gl.v === 0 ? [[-1, 0], [0, -1], [0, 1], [1, 0]] : [[1, 0], [0, -1], [0, 1], [-1, 0]]);
    while (h < t) {
      const c = q[h++];
      const x = (c / N) | 0, y = c % N;
      if (atGoal(seat, x, y)) {
        if (!wantPath) return { d: dist[c] };
        const path = [];
        for (let k = c; k !== -1; k = prev[k]) path.push({ x: (k / N) | 0, y: k % N });
        return { d: dist[c], path: path.reverse() };
      }
      for (const [dx, dy] of order) {
        if (!canStep(g, x, y, dx, dy)) continue;
        const nk = (x + dx) * N + (y + dy);
        if (prev[nk] !== -2) continue;
        prev[nk] = c;
        dist[nk] = dist[c] + 1;
        q[t++] = nk;
      }
    }
    return { d: -1, path: null };
  }

  /** 다른 벽과 겹치거나 엇갈리지 않는지만 본다 (길 막힘은 따로) */
  function wallFits(g, x, y, o) {
    if (!(x >= 0 && y >= 0 && x < G && y < G)) return false;
    if (g.hw[x][y] || g.vw[x][y]) return false;
    if (o === 'h') {
      if (x > 0 && g.hw[x - 1][y]) return false;
      if (x < G - 1 && g.hw[x + 1][y]) return false;
    } else {
      if (y > 0 && g.vw[x][y - 1]) return false;
      if (y < G - 1 && g.vw[x][y + 1]) return false;
    }
    return true;
  }

  /**
   * i 번이 (x,y,o) 벽을 세울 수 있는지. 안 되면 이유를 돌려준다.
   *   'none' 남은 벽 없음 · 'overlap' 겹침 · 'block' 누군가 길이 막힘 · null 가능
   */
  function wallProblem(g, i, x, y, o) {
    if (o !== 'h' && o !== 'v') return 'overlap';
    if (g.pawns[i] && g.pawns[i].walls <= 0) return 'none';
    if (!wallFits(g, x, y, o)) return 'overlap';
    const m = o === 'h' ? g.hw : g.vw;
    m[x][y] = true;
    let ok = true;
    for (let k = 0; k < g.pawns.length && ok; k++) {
      if (g.pawns[k].out) continue;
      if (distance(g, k) < 0) ok = false;
    }
    m[x][y] = false;
    return ok ? null : 'block';
  }

  const WALL_WHY = {
    none: '남은 벽이 없어요',
    overlap: '다른 벽과 겹쳐요',
    block: '누군가의 길을 완전히 막아요',
  };

  /** 다음 차례 — 빠진 말은 건너뛴다 */
  function advance(g) {
    for (let k = 1; k <= g.pawns.length; k++) {
      const j = (g.turn + k) % g.pawns.length;
      if (!g.pawns[j].out) { g.turn = j; return; }
    }
  }

  /**
   * 수 두기. a = { k:'move', x, y } | { k:'wall', x, y, o }
   * 틀린 수면 { error } 를, 맞으면 { ok, won } 을 돌려주고 g 를 바꾼다.
   */
  function apply(g, i, a) {
    if (g.winner >= 0) return { error: '이미 끝난 판이에요' };
    if (i !== g.turn) return { error: '내 차례가 아니에요' };
    if (!a) return { error: '잘못된 수' };
    const p = g.pawns[i];
    if (a.k === 'move') {
      const x = a.x | 0, y = a.y | 0;
      if (!pawnMoves(g, i).some(m => m.x === x && m.y === y)) return { error: '그 칸으로는 갈 수 없어요' };
      p.x = x; p.y = y;
      g.ply++;
      if (atGoal(p.seat, x, y)) { g.winner = i; return { ok: true, won: true }; }
      advance(g);
      return { ok: true };
    }
    if (a.k === 'wall') {
      const x = a.x | 0, y = a.y | 0, o = a.o;
      const why = wallProblem(g, i, x, y, o);
      if (why) return { error: WALL_WHY[why] };
      (o === 'h' ? g.hw : g.vw)[x][y] = true;
      g.walls.push({ x, y, o, by: i });
      p.walls--;
      g.ply++;
      advance(g);
      return { ok: true };
    }
    return { error: '잘못된 수' };
  }

  /** i 번을 판에서 뺀다(기권 · 나감). 한 명만 남으면 그 사람이 이긴다 */
  function retire(g, i) {
    const p = g.pawns[i];
    if (!p || p.out || g.winner >= 0) return;
    p.out = true;
    const left = g.pawns.map((q, k) => (q.out ? -1 : k)).filter(k => k >= 0);
    if (left.length === 1) { g.winner = left[0]; return; }
    if (g.turn === i) advance(g);
  }

  /* ─────────────────────────── 봇 ─────────────────────────── */

  /** 벽 후보 — 상대의 가장 짧은 길을 끊는 자리들 */
  function cuttingWalls(g, target, into) {
    const path = shortestPath(g, target);
    if (!path) return;
    for (let s = 0; s + 1 < path.length; s++) {
      const a = path[s], b = path[s + 1];
      if (a.x === b.x) {
        const wy = Math.min(a.y, b.y);
        into.push({ k: 'wall', x: a.x - 1, y: wy, o: 'h' }, { k: 'wall', x: a.x, y: wy, o: 'h' });
      } else {
        const wx = Math.min(a.x, b.x);
        into.push({ k: 'wall', x: wx, y: a.y - 1, o: 'v' }, { k: 'wall', x: wx, y: a.y, o: 'v' });
      }
    }
  }

  function candidates(g, i, targets) {
    const list = pawnMoves(g, i).map(m => ({ k: 'move', x: m.x, y: m.y }));
    if (g.pawns[i].walls > 0) {
      const walls = [];
      for (const t of targets) cuttingWalls(g, t, walls);
      const seen = new Set();
      for (const w of walls) {
        const key = w.o + w.x + ',' + w.y;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!wallProblem(g, i, w.x, w.y, w.o)) list.push(w);
      }
    }
    return list;
  }

  const others = (g, i) => g.pawns.map((p, k) => k).filter(k => k !== i && !g.pawns[k].out);

  /** i 번 입장에서 판이 얼마나 좋은지 */
  function evaluate(g, i) {
    if (g.winner >= 0) return g.winner === i ? 1000 : -1000;
    const me = distance(g, i);
    let best = Infinity, bestWalls = 0;
    for (const k of others(g, i)) {
      const d = distance(g, k);
      if (d < best) { best = d; bestWalls = g.pawns[k].walls; }
    }
    // 차례가 먼저 오는 쪽이 반 걸음 앞선다
    const tempo = g.turn === i ? 0.5 : -0.5;
    return (best - me) + tempo + 0.22 * (g.pawns[i].walls - bestWalls) - 0.01 * me;
  }

  /** 가장 앞선 상대 — 벽은 그쪽을 겨눈다 */
  function leader(g, i) {
    let best = -1, bd = Infinity;
    for (const k of others(g, i)) {
      const d = distance(g, k);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  /**
   * 봇이 둘 수.  level: 'easy' | 'normal' | 'hard'
   * rnd 는 시험에서 결과를 고정하려고 바꿔 끼울 수 있다.
   */
  function botMove(g, i, level, rnd) {
    rnd = rnd || Math.random;
    const lead = leader(g, i);
    const myD = distance(g, i);

    // 한 걸음에 이기면 그냥 간다
    for (const m of pawnMoves(g, i)) if (atGoal(g.pawns[i].seat, m.x, m.y)) return { k: 'move', x: m.x, y: m.y };

    if (level === 'easy') {
      const moves = pawnMoves(g, i);
      const scored = moves.map(m => {
        const t = clone(g); t.pawns[i].x = m.x; t.pawns[i].y = m.y;
        return { a: { k: 'move', x: m.x, y: m.y }, s: -distance(t, i) + rnd() * 1.6 };
      });
      // 가끔 상대 길목에 벽 하나
      if (lead >= 0 && g.pawns[i].walls > 0 && distance(g, lead) < myD && rnd() < 0.3) {
        const ws = candidates(g, i, [lead]).filter(a => a.k === 'wall');
        if (ws.length) return ws[(rnd() * ws.length) | 0];
      }
      scored.sort((a, b) => b.s - a.s);
      return scored[0].a;
    }

    const targets = lead >= 0 ? [lead] : [];
    const mine = candidates(g, i, targets);
    const deep = level === 'hard' && g.n === 2;
    const noise = level === 'hard' ? 0.05 : 0.35;
    const behind = lead >= 0 && distance(g, lead) <= myD;

    let best = null, bestS = -Infinity;
    for (const a of mine) {
      const t = clone(g);
      if (apply(t, i, a).error) continue;
      let s;
      if (deep && t.winner < 0) {
        // 상대가 가장 아프게 받아친다고 보고 그중 최악을 점수로 삼는다
        const j = t.turn;
        let worst = Infinity;
        for (const b of candidates(t, j, [i])) {
          const u = clone(t);
          if (apply(u, j, b).error) continue;
          const v = evaluate(u, i);
          if (v < worst) worst = v;
          if (worst <= -1000) break;
        }
        s = worst === Infinity ? evaluate(t, i) : worst;
      } else {
        s = evaluate(t, i);
      }
      // 벽은 아껴 둔다 — 내가 앞서면 굳이 쓰지 않고, 뒤지거나 비등하면 적극적으로 끊는다
      if (a.k === 'wall' && !deep) s += behind ? 0.25 : -0.35;
      s += rnd() * noise;
      if (s > bestS) { bestS = s; best = a; }
    }
    if (best) return best;
    return fallbackMove(g, i);
  }

  /** 시간이 다 됐을 때 대신 두는 수 — 결승선에 가까워지는 쪽으로 한 걸음 */
  function fallbackMove(g, i) {
    let best = null, bd = Infinity;
    for (const m of pawnMoves(g, i)) {
      const t = clone(g); t.pawns[i].x = m.x; t.pawns[i].y = m.y;
      const d = distance(t, i);
      if (d >= 0 && d < bd) { bd = d; best = { k: 'move', x: m.x, y: m.y }; }
    }
    return best;
  }

  /* ─────────────────────────── 화면 회전 ─────────────────────────── */
  // 내 말이 늘 아래에 오도록 판을 돌린다. k = 반시계 90° 몇 번.

  function rotCell(x, y, k) {
    for (let s = 0; s < ((k % 4) + 4) % 4; s++) { const nx = y, ny = G - x; x = nx; y = ny; }
    return { x, y };
  }
  function rotWall(x, y, o, k) {
    for (let s = 0; s < ((k % 4) + 4) % 4; s++) { const nx = y, ny = G - 1 - x; x = nx; y = ny; o = o === 'h' ? 'v' : 'h'; }
    return { x, y, o };
  }

  // 첫 화면에서 되풀이해 보여 주는 봇끼리 세 판 (m 이동 · h/v 벽, 뒤 두 자리는 x y)
  const DEMO_GAMES = [
    'm58 m41 m57 m42 h37 m43 m56 m44 m55 m45 m54 m46 h57 m47 m53 h52 v27 v42 h77 m37 h36 m47 v35 m57 h56 m67 v33 m77 v31 m76 h17 m75 m63 v63 m64 m74 m54 h41 m55 v55 m54 m73 m64 m72 m65 m71 m75 m70 m74 m60 m73 m50 m72 m40 m71 h60 m81 m41 m80',
    'm47 m41 m46 m42 h47 m43 m45 h31 h36 m53 m55 h51 h67 h71 h53 v44 m56 v46 m66 v52 h17 h11 m67 v76 m77 v74 m76 h65 v26 m43 m66 m33 m56 m23 m55 m24 m54 m14 m64 m04 m74 m05 m73 m06 m83 m07 m84 m08',
    'm47 m41 m46 m42 m45 h41 m44 m43 m42 h20 m32 h40 m31 v11 m21 v31 m22 h01 h33 h61 m23 v23 v43 v52 h55 v45 m22 m33 h12 m43 v64 m42 m32 m52 m33 m53 m43 m54 m42 m64 m52 m63 m53 m73 m54 m74 m64 m75 m63 m76 m73 m77 h67 m87 m83 m88',
  ];

  const R = {
    N, G, SEATS, seatsFor, wallsFor,
    newGame, clone, canStep, pawnAt, pawnMoves, atGoal,
    distance, shortestPath, wallFits, wallProblem, WALL_WHY,
    apply, retire, botMove, fallbackMove,
    rotCell, rotWall, DEMO_GAMES,
  };

  if (typeof module === 'object' && module.exports) module.exports = R;
  else root.Q = R;
})(typeof globalThis !== 'undefined' ? globalThis : this);
