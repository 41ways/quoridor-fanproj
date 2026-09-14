/**
 * 쿼리도 판 그리기 — SVG 한 장.
 *
 * 타이틀의 구경용 판, 규칙 그림, 실제 판이 모두 이걸 쓴다.
 * 좌표는 이미 "화면 기준"(내 말이 아래)으로 돌려서 넘겨받는다. 돌리는 건 app.js 몫.
 *
 * 색은 전부 CSS 변수(style.css)에서 온다. 테마를 바꿔도 다시 그릴 필요가 없다.
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const C = 100;          // 칸
  const GP = 24;          // 홈(벽 두께 자리)
  const PAD = 46;         // 테두리
  const U = C + GP;
  const SIZE = PAD * 2 + 9 * C + 8 * GP;

  const cellX = x => PAD + x * U;                   // 칸 왼쪽 위
  const cellC = x => PAD + x * U + C / 2;           // 칸 가운데
  const grooveC = i => PAD + (i + 1) * U - GP / 2;  // i 번째 홈(교차점) 가운데

  let uid = 0;
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };

  /* 나뭇결 — 캔버스로 한 번 그려서 모든 판이 무늬로 나눠 쓴다.
     색 없이 밝고 어두운 결만 담아서 어느 테마 위에 얹어도 된다. */
  let grainURL = null;
  function grain() {
    if (grainURL) return grainURL;
    const w = 512, h = 512;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    let seed = 20260914;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 150; k++) {
      const y0 = r() * h;
      const amp = 2 + r() * 9;
      const freq = 0.004 + r() * 0.012;
      const ph = r() * 6.28;
      const dark = r() < 0.62;
      g.strokeStyle = dark ? `rgba(40,20,5,${0.05 + r() * 0.12})` : `rgba(255,240,210,${0.04 + r() * 0.08})`;
      g.lineWidth = 0.6 + r() * 2.4;
      g.beginPath();
      for (let x = -8; x <= w + 8; x += 8) {
        const y = y0 + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph * 2) * amp * 0.25;
        x === -8 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      // 이음새가 보이지 않게 위아래로 한 벌 더
      g.save(); g.translate(0, y0 > h / 2 ? -h : h); g.stroke(); g.restore();
    }
    // 옹이 몇 개
    for (let k = 0; k < 3; k++) {
      const cx = r() * w, cy = r() * h, rr = 6 + r() * 10;
      for (let q = 0; q < 5; q++) {
        g.strokeStyle = `rgba(40,20,5,${0.05 + q * 0.015})`;
        g.lineWidth = 1;
        g.beginPath(); g.ellipse(cx, cy, rr + q * 4, (rr + q * 4) * 0.45, 0, 0, 6.29); g.stroke();
      }
    }
    // 잔 결
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 14;
      img.data[i + 3] = Math.max(0, Math.min(255, img.data[i + 3] + Math.abs(n)));
    }
    g.putImageData(img, 0, 0);
    grainURL = cv.toDataURL('image/png');
    return grainURL;
  }

  class Board {
    /**
     * opts.mini  — 규칙 그림처럼 작게 쓰는 판 (결·그림자 줄임)
     * opts.onHover(target) · opts.onPick(target, pointerType)  — 실제 판에서만
     */
    constructor(svg, opts = {}) {
      this.svg = svg;
      this.opts = opts;
      this.id = 'b' + (++uid);
      this.pawnEls = new Map();
      this.wallEls = new Map();
      this.seen = false;
      if (opts.crop) {
        // 규칙 그림 — 판 일부만 크게 [왼쪽 칸, 위 칸, 가로 칸 수, 세로 칸 수]
        const [cx, cy, w, h] = opts.crop;
        const x0 = cellX(cx) - GP / 2 - 4, y0 = cellX(cy) - GP / 2 - 4;
        svg.setAttribute('viewBox', `${x0} ${y0} ${w * U + 8} ${h * U + 8}`);
      } else {
        svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
      }
      svg.classList.add('board-svg');
      if (opts.mini) svg.classList.add('mini');
      this.build();
      if (opts.onPick) this.bindPointer();
    }

    /** 새 판 — 이벤트는 그대로 두고 그림만 새로 */
    reset() {
      this.pawnEls.clear();
      this.wallEls.clear();
      this.seen = false;
      this.goalKey = this.hintKey = this.pathKey = this.footKey = this.ghostKey = this.ghostPKey = null;
      this.ghostP = null;
      this.build();
    }

    build() {
      const s = this.svg;
      s.textContent = '';
      const id = this.id;
      const defs = el('defs', null, s);

      // 테두리 · 칸 · 벽 결 무늬
      const pat = el('pattern', { id: id + 'grain', patternUnits: 'userSpaceOnUse', width: 512, height: 512 }, defs);
      el('image', { href: grain(), width: 512, height: 512, preserveAspectRatio: 'none' }, pat);
      const patTile = el('pattern', { id: id + 'grainT', patternUnits: 'userSpaceOnUse', width: 320, height: 320, patternTransform: 'rotate(90) scale(0.62)' }, defs);
      el('image', { href: grain(), width: 320, height: 320, preserveAspectRatio: 'none' }, patTile);

      const lin = (gid, stops, x2 = 0, y2 = 1) => {
        const g = el('linearGradient', { id: id + gid, x1: 0, y1: 0, x2, y2 }, defs);
        for (const [o, v] of stops) el('stop', { offset: o, style: `stop-color:var(${v})` }, g);
        return g;
      };
      lin('frame', [[0, '--frame-hi'], [0.5, '--frame'], [1, '--frame-lo']], 1, 1);
      lin('tile', [[0, '--tile-hi'], [1, '--tile-lo']], 0.3, 1);
      lin('wallH', [[0, '--wall-hi'], [0.55, '--wall'], [1, '--wall-lo']], 0, 1);
      lin('wallV', [[0, '--wall-hi'], [0.55, '--wall'], [1, '--wall-lo']], 1, 0);

      for (let seat = 0; seat < 4; seat++) {
        const rg = el('radialGradient', { id: `${id}pawn${seat}`, cx: '38%', cy: '32%', r: '72%' }, defs);
        el('stop', { offset: 0, style: `stop-color:var(--s${seat}-hi)` }, rg);
        el('stop', { offset: 0.55, style: `stop-color:var(--s${seat})` }, rg);
        el('stop', { offset: 1, style: `stop-color:var(--s${seat}-lo)` }, rg);
      }
      const sh = el('radialGradient', { id: id + 'shadow' }, defs);
      el('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0.42 }, sh);
      el('stop', { offset: 0.6, 'stop-color': '#000', 'stop-opacity': 0.16 }, sh);
      el('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0 }, sh);

      // 테두리
      const frame = el('g', { class: 'frame' }, s);
      el('rect', { x: 0, y: 0, width: SIZE, height: SIZE, rx: 44, fill: `url(#${id}frame)` }, frame);
      el('rect', { x: 0, y: 0, width: SIZE, height: SIZE, rx: 44, fill: `url(#${id}grain)`, class: 'grain-over' }, frame);
      el('rect', { x: 3, y: 3, width: SIZE - 6, height: SIZE - 6, rx: 41, class: 'frame-bevel' }, frame);
      el('rect', { x: PAD - 12, y: PAD - 12, width: SIZE - 2 * PAD + 24, height: SIZE - 2 * PAD + 24, rx: 20, class: 'bed' }, frame);

      this.goalG = el('g', { class: 'goals' }, s);

      // 칸
      const tiles = el('g', { class: 'tiles' }, s);
      this.tiles = [];
      for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
        const g = el('g', { class: 'tile' }, tiles);
        el('rect', { x: cellX(x), y: cellX(y) + 3, width: C, height: C, rx: 13, class: 'tile-side' }, g);
        const top = el('rect', { x: cellX(x), y: cellX(y), width: C, height: C, rx: 13, fill: `url(#${id}tile)` }, g);
        el('rect', { x: cellX(x), y: cellX(y), width: C, height: C, rx: 13, fill: `url(#${id}grainT)`, class: 'grain-over tile-grain' }, g);
        const tint = el('rect', { x: cellX(x), y: cellX(y), width: C, height: C, rx: 13, class: 'tile-tint' }, g);
        el('rect', { x: cellX(x) + 1.5, y: cellX(y) + 1.5, width: C - 3, height: C - 3, rx: 12, class: 'tile-edge' }, g);
        this.tiles.push({ g, top, tint });
      }

      this.pathG = el('g', { class: 'paths' }, s);
      this.footG = el('g', { class: 'feet' }, s);
      this.hintG = el('g', { class: 'hints' }, s);
      this.wallG = el('g', { class: 'walls' }, s);
      this.ghostG = el('g', { class: 'ghost' }, s);
      this.pawnG = el('g', { class: 'pawns' }, s);
      this.fxG = el('g', { class: 'fx' }, s);
    }

    /* ───────────── 그리기 ───────────── */

    /**
     * v = {
     *   pawns: [{ key, seat, x, y, out, active, me }],
     *   walls: [{ x, y, o, seat }],
     *   goals: [{ seat, side: 'top'|'bottom'|'left'|'right' }],
     *   moves: [{ x, y }],            // 갈 수 있는 칸 (내 차례일 때)
     *   mover: seat,                  // 힌트 색
     *   paths: [{ seat, cells, mine }],
     *   foot: { x, y, seat } | null,  // 방금 떠난 자리
     *   fresh: 'x,y,o' | null,        // 방금 세운 벽 — 떨어지는 애니메이션
     * }
     */
    render(v) {
      this.renderGoals(v.goals || []);
      this.renderWalls(v.walls || [], v.fresh);
      this.renderPawns(v.pawns || []);
      this.renderHints(v.moves || [], v.mover);
      this.renderPaths(v.paths || []);
      this.renderFoot(v.foot);
      this.seen = true;
    }

    renderGoals(goals) {
      const key = goals.map(g => g.seat + g.side).join('|');
      if (key === this.goalKey) return;
      this.goalKey = key;
      this.goalG.textContent = '';
      for (const t of this.tiles) t.tint.removeAttribute('style');
      for (const e of this.splitEls || []) e.remove();
      this.splitEls = [];
      const owners = new Map();   // 칸 → [{ seat, side }] — 4인전 모서리는 두 사람의 결승선이 겹친다
      for (const { seat, side } of goals) {
        const long = SIZE - 2 * PAD - 60;
        const th = 9;
        let x, y, w, h;
        if (side === 'top')    { x = PAD + 30; y = PAD / 2 - th / 2 - 4; w = long; h = th; }
        if (side === 'bottom') { x = PAD + 30; y = SIZE - PAD / 2 - th / 2 + 4; w = long; h = th; }
        if (side === 'left')   { x = PAD / 2 - th / 2 - 4; y = PAD + 30; w = th; h = long; }
        if (side === 'right')  { x = SIZE - PAD / 2 - th / 2 + 4; y = PAD + 30; w = th; h = long; }
        el('rect', { x, y, width: w, height: h, rx: th / 2, class: 'goal-bar', style: `fill:var(--s${seat})` }, this.goalG);
        for (let k = 0; k < 9; k++) {
          const cx = side === 'left' ? 0 : side === 'right' ? 8 : k;
          const cy = side === 'top' ? 0 : side === 'bottom' ? 8 : k;
          const i = cy * 9 + cx;
          if (!owners.has(i)) owners.set(i, []);
          owners.get(i).push({ seat, side });
        }
      }
      for (const [i, list] of owners) {
        const t = this.tiles[i];
        if (list.length === 1) {
          t.tint.setAttribute('style', `fill:var(--s${list[0].seat});opacity:var(--goal-tint)`);
          continue;
        }
        // 겹친 모서리 — 바깥 꼭짓점을 지나는 대각선으로 반씩. 각 반쪽은 그 사람의 결승선 변에 닿는다
        const x0 = cellX(i % 9), y0 = cellX((i / 9) | 0), x1 = x0 + C, y1 = y0 + C;
        const clipId = `${this.id}clip${i}`;
        if (!this.svg.getElementById(clipId)) {
          const cp = el('clipPath', { id: clipId }, this.svg.querySelector('defs'));
          el('rect', { x: x0, y: y0, width: C, height: C, rx: 13 }, cp);
        }
        const tri = {
          top:    `M${x0},${y0} L${x1},${y0} L${list.some(o => o.side === 'left') ? `${x1},${y1}` : `${x0},${y1}`} Z`,
          bottom: `M${x0},${y1} L${x1},${y1} L${list.some(o => o.side === 'left') ? `${x1},${y0}` : `${x0},${y0}`} Z`,
          left:   `M${x0},${y0} L${x0},${y1} L${list.some(o => o.side === 'top') ? `${x1},${y1}` : `${x1},${y0}`} Z`,
          right:  `M${x1},${y0} L${x1},${y1} L${list.some(o => o.side === 'top') ? `${x0},${y1}` : `${x0},${y0}`} Z`,
        };
        for (const { seat, side } of list) {
          const path = el('path', { d: tri[side], 'clip-path': `url(#${clipId})`, class: 'tile-tint', style: `fill:var(--s${seat});opacity:var(--goal-tint)` });
          t.g.insertBefore(path, t.tint);
          this.splitEls.push(path);
        }
      }
    }

    renderWalls(walls, fresh) {
      const want = new Set();
      for (const w of walls) {
        const k = `${w.x},${w.y},${w.o}`;
        want.add(k);
        if (this.wallEls.has(k)) continue;
        const g = this.wallShape(this.wallG, w.x, w.y, w.o, w.seat, 'wall');
        this.wallEls.set(k, g);
        if (this.seen && k === fresh) {
          g.classList.add('drop');
          this.thud(w);
        }
      }
      for (const [k, g] of this.wallEls) if (!want.has(k)) { g.remove(); this.wallEls.delete(k); }
    }

    wallRect(x, y, o) {
      const len = 2 * C + GP - 6;
      const th = GP + 10;   // 홈보다 조금 두껍게 — 칸 가장자리에 살짝 걸쳐야 벽이 서 있는 게 보인다
      if (o === 'h') return { x: cellX(x) + 3, y: grooveC(y) - th / 2, w: len, h: th };
      return { x: grooveC(x) - th / 2, y: cellX(y) + 3, w: th, h: len };
    }

    wallShape(parent, x, y, o, seat, cls) {
      const r = this.wallRect(x, y, o);
      const g = el('g', { class: cls }, parent);
      const inner = el('g', { class: 'wall-in' }, g);
      el('rect', { x: r.x + 4, y: r.y + 12, width: r.w, height: r.h, rx: 9, class: 'wall-shadow' }, inner);
      el('rect', { x: r.x, y: r.y + 6, width: r.w, height: r.h, rx: 9, class: 'wall-side' }, inner);
      el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 9, fill: `url(#${this.id}wall${o.toUpperCase()})`, class: 'wall-top' }, inner);
      el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 9, fill: `url(#${this.id}grain)`, class: 'grain-over wall-grain' }, inner);
      // 누가 세웠는지 — 가운데 가는 색띠
      if (seat != null) {
        const cap = o === 'h'
          ? { x: r.x + 18, y: r.y + r.h / 2 - 4, width: r.w - 36, height: 8 }
          : { x: r.x + r.w / 2 - 4, y: r.y + 18, width: 8, height: r.h - 36 };
        el('rect', Object.assign(cap, { rx: 4, class: 'wall-cap', style: `fill:var(--s${seat})` }), inner);
      }
      el('rect', { x: r.x + 1.5, y: r.y + 1.5, width: r.w - 3, height: r.h - 3, rx: 8, class: 'wall-hi' }, inner);
      return g;
    }

    thud(w) {
      const r = this.wallRect(w.x, w.y, w.o);
      const ring = el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, class: 'thud', style: `stroke:var(--s${w.seat == null ? 0 : w.seat})` }, this.fxG);
      setTimeout(() => ring.remove(), 900);
      this.svg.classList.remove('shake');
      void this.svg.getBoundingClientRect();
      this.svg.classList.add('shake');
    }

    renderPawns(pawns) {
      const want = new Set();
      for (const p of pawns) {
        if (p.out) continue;
        want.add(p.key);
        let e = this.pawnEls.get(p.key);
        const tx = cellC(p.x), ty = cellC(p.y);
        if (!e) {
          e = this.pawnShape(p.seat);
          this.pawnEls.set(p.key, e);
          e.g.style.transform = `translate(${tx}px,${ty}px)`;
          if (this.seen) e.g.classList.add('pop');
          e.x = p.x; e.y = p.y;
        } else if (e.x !== p.x || e.y !== p.y) {
          const far = Math.abs(e.x - p.x) + Math.abs(e.y - p.y) > 1;
          e.g.style.transform = `translate(${tx}px,${ty}px)`;
          e.body.classList.remove('hop', 'step');
          void e.body.getBoundingClientRect();
          e.body.classList.add(far ? 'hop' : 'step');
          e.x = p.x; e.y = p.y;
        }
        e.g.classList.toggle('active', !!p.active);
        e.g.classList.toggle('me', !!p.me);
        if (e.seat !== p.seat) { e.g.remove(); this.pawnEls.delete(p.key); }
      }
      for (const [k, e] of this.pawnEls) {
        if (want.has(k)) continue;
        e.g.classList.add('gone');
        this.pawnEls.delete(k);
        setTimeout(() => e.g.remove(), 500);
      }
    }

    pawnShape(seat, parent) {
      const id = this.id;
      const g = el('g', { class: `pawn s${seat}` }, parent || this.pawnG);
      el('circle', { r: 52, class: 'halo', style: `stroke:var(--s${seat})` }, g);
      const body = el('g', { class: 'pawn-body' }, g);
      el('ellipse', { cx: 6, cy: 16, rx: 48, ry: 42, fill: `url(#${id}shadow)`, class: 'pawn-shadow' }, body);
      const lift = el('g', { class: 'pawn-lift' }, body);
      el('circle', { cy: 7, r: 39, class: 'pawn-side', style: `fill:var(--s${seat}-lo)` }, lift);
      el('circle', { r: 39, fill: `url(#${id}pawn${seat})` }, lift);
      el('circle', { r: 26, class: 'pawn-ring' }, lift);
      el('circle', { r: 11, class: 'pawn-dimple', style: `fill:var(--s${seat}-lo)` }, lift);
      el('ellipse', { cx: -14, cy: -18, rx: 14, ry: 7.5, class: 'pawn-gloss', transform: 'rotate(-32 -14 -18)' }, lift);
      return { g, body, seat, x: -1, y: -1 };
    }

    renderHints(moves, mover) {
      const key = moves.map(m => m.x + ',' + m.y).join(' ') + '|' + mover;
      if (key === this.hintKey) return;
      this.hintKey = key;
      this.hintG.textContent = '';
      for (const m of moves) {
        const g = el('g', { class: 'hint', style: `--c:var(--s${mover})` }, this.hintG);
        el('rect', { x: cellX(m.x) + 6, y: cellX(m.y) + 6, width: C - 12, height: C - 12, rx: 11, class: 'hint-bg' }, g);
        el('circle', { cx: cellC(m.x), cy: cellC(m.y), r: 13, class: 'hint-dot' }, g);
        el('circle', { cx: cellC(m.x), cy: cellC(m.y), r: 13, class: 'hint-ring' }, g);
      }
    }

    renderPaths(paths) {
      const key = JSON.stringify(paths);
      if (key === this.pathKey) return;
      this.pathKey = key;
      this.pathG.textContent = '';
      for (const p of paths) {
        if (!p.cells || p.cells.length < 2) continue;
        const pts = p.cells.map(c => `${cellC(c.x)},${cellC(c.y)}`).join(' ');
        el('polyline', { points: pts, class: 'path' + (p.mine ? ' mine' : ''), style: `stroke:var(--s${p.seat})` }, this.pathG);
        const end = p.cells[p.cells.length - 1];
        el('circle', { cx: cellC(end.x), cy: cellC(end.y), r: 9, class: 'path-end' + (p.mine ? ' mine' : ''), style: `fill:var(--s${p.seat})` }, this.pathG);
      }
    }

    renderFoot(f) {
      const key = f ? `${f.x},${f.y},${f.seat}` : '';
      if (key === this.footKey) return;
      this.footKey = key;
      this.footG.textContent = '';
      if (!f) return;
      el('circle', { cx: cellC(f.x), cy: cellC(f.y), r: 26, class: 'foot', style: `stroke:var(--s${f.seat})` }, this.footG);
    }

    /* ───────────── 미리보기 ───────────── */

    /** 벽 미리보기. state: 'ok' | 'bad' | 'pending' */
    ghostWall(w, seat, state) {
      const key = w ? `${w.x},${w.y},${w.o},${seat},${state}` : '';
      if (key === this.ghostKey) return;
      this.ghostKey = key;
      this.ghostG.textContent = '';
      if (!w) return;
      const g = this.wallShape(this.ghostG, w.x, w.y, w.o, state === 'bad' ? null : seat, 'wall ghost-wall ' + state);
      if (state === 'bad') {
        const r = this.wallRect(w.x, w.y, w.o);
        el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 9, class: 'bad-over' }, g);
      }
    }

    ghostPawn(c, seat) {
      const key = c ? `p${c.x},${c.y},${seat}` : '';
      if (key === this.ghostPKey) return;
      this.ghostPKey = key;
      if (this.ghostP) { this.ghostP.g.remove(); this.ghostP = null; }
      if (!c) return;
      this.ghostP = this.pawnShape(seat, this.ghostG);
      this.ghostP.g.classList.add('ghost-pawn');
      this.ghostP.g.style.transform = `translate(${cellC(c.x)}px,${cellC(c.y)}px)`;
    }

    clearGhost() { this.ghostWall(null); this.ghostPawn(null); }

    /** 판 위에 이모지가 떠오른다 */
    floatAt(x, y, text) {
      const t = el('text', { x: cellC(x), y: cellC(y) - 40, class: 'float-emote', 'text-anchor': 'middle' }, this.fxG);
      t.textContent = text;
      setTimeout(() => t.remove(), 1800);
    }

    /* ───────────── 입력 ───────────── */

    /** 화면 좌표 → 칸 또는 벽 자리 */
    targetAt(clientX, clientY, prefer, touch) {
      const pt = this.svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const m = this.svg.getScreenCTM();
      if (!m) return null;
      const p = pt.matrixTransform(m.inverse());
      const lx = p.x - PAD, ly = p.y - PAD;
      const span = 9 * C + 8 * GP;
      if (lx < -GP || ly < -GP || lx > span + GP || ly > span + GP) return null;

      const ix = Math.floor(lx / U), iy = Math.floor(ly / U);
      const fx = lx - ix * U, fy = ly - iy * U;       // 칸 안에서 0..C, 홈은 C..U
      const cx = Math.max(0, Math.min(8, ix)), cy = Math.max(0, Math.min(8, iy));

      // 홈까지 거리 (칸 안이면 가까운 쪽 가장자리까지)
      const band = touch ? 34 : 18;   // 손가락은 넉넉하게
      const nearV = fx >= C ? 0 : Math.min(ix > 0 ? fx : 1e9, ix < 8 ? C - fx : 1e9);
      const nearH = fy >= C ? 0 : Math.min(iy > 0 ? fy : 1e9, iy < 8 ? C - fy : 1e9);
      const inV = nearV <= band, inH = nearH <= band;

      const cell = { kind: 'cell', x: cx, y: cy };
      if (prefer && prefer(cell) && fx < C && fy < C && lx >= 0 && ly >= 0 && lx <= span && ly <= span) return cell;
      if (!inV && !inH) return (lx >= 0 && ly >= 0 && lx <= span && ly <= span) ? cell : null;

      let o;
      if (inH && !inV) o = 'h';
      else if (inV && !inH) o = 'v';
      else o = nearH <= nearV ? 'h' : 'v';

      const clamp = v => Math.max(0, Math.min(7, v));
      if (o === 'h') {
        const gy = fy >= C ? iy : (fy < C / 2 ? iy - 1 : iy);
        const gx = Math.round((lx + GP / 2) / U) - 1;
        if (gy < 0 || gy > 7) return cell;
        return { kind: 'wall', x: clamp(gx), y: gy, o };
      }
      const gx = fx >= C ? ix : (fx < C / 2 ? ix - 1 : ix);
      const gy = Math.round((ly + GP / 2) / U) - 1;
      if (gx < 0 || gx > 7) return cell;
      return { kind: 'wall', x: gx, y: clamp(gy), o };
    }

    bindPointer() {
      const s = this.svg;
      let down = null;
      s.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse') return;
        this.opts.onHover && this.opts.onHover(this.targetAt(e.clientX, e.clientY, this.opts.prefer), e.clientX, e.clientY);
      });
      s.addEventListener('pointerleave', e => {
        if (e.pointerType === 'mouse') this.opts.onHover && this.opts.onHover(null);
      });
      s.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
      s.addEventListener('pointerup', e => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved > 14) return;
        const t = this.targetAt(e.clientX, e.clientY, this.opts.prefer, e.pointerType !== 'mouse');
        this.opts.onPick(t, e.pointerType, e.clientX, e.clientY);
      });
    }
  }

  Board.SIZE = SIZE;
  Board.grain = grain;
  window.Board = Board;
})();
