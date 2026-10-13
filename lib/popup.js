/*
 * popup.js — rigid-paper pop-up book mechanics.
 *
 * Coordinate system (the same one you design in):
 *   - The spine (gutter) is the Z axis. +Z points toward the reader
 *     (bottom edge of the book), -Z toward the top edge.
 *   - Y is up. The right page lies flat on the table in the plane y = 0, x > 0.
 *   - The left page swings about the spine. Its opening angle `phi` is the
 *     angle between the two pages: phi = 0 is closed (left page lying face-down
 *     on the right page), phi = PI is the flat open spread (left page at x < 0).
 *
 * You author a pop-up in its fully-open state (phi = PI) as rigid paper
 * panels in world coordinates. Panels that share a point are hinged there;
 * two shared points make a fold line. Points on the page surface (y = 0) are
 * glued to the page under them (x < 0 left, x > 0 right, x = 0 the spine).
 *
 * The Simulation then folds the book by continuation: it moves the pages a
 * small step at a time and solves for the paper's position, keeping every
 * panel rigid (a damped Gauss-Newton solve), every glue point on its page, and all paper
 * inside the wedge between the two pages. Because the design state is the
 * open one and the solver only ever moves continuously from the previous
 * solution, mechanisms fold the way paper does — never inside-out.
 *
 * strain() reports how far the paper had to deform to follow the pages; a
 * design that can be built from rigid card folds with strain ~ 0. A design
 * that cannot (it would tear or crumple) shows strain, which is the cue to
 * change the design.
 *
 * No dependencies. Works in the browser (window.Popup) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Popup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  // ── small vector helpers (arrays of 3) ──────────────────────────────────────
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => scale(a, 1 / (len(a) || 1));
  const lerp = (a, b, t) => add(a, scale(sub(b, a), t));

  // ── Book: page frames as a function of the opening angle ───────────────────
  // Each page has a frame { u, v, n }: u runs away from the spine across the
  // page, v runs along the spine (+Z), n is the printed side's normal (the
  // side facing the other page). A page point (u, v, w) is at
  // u*U + v*V + w*N in world space.
  function pageFrame(side, phi) {
    if (side === 'right') return { u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] };
    if (side === 'left') {
      const c = Math.cos(phi), s = Math.sin(phi);
      return { u: [c, s, 0], v: [0, 0, 1], n: [s, -c, 0] };
    }
    // spine: the axis itself
    return { u: [0, 0, 0], v: [0, 0, 1], n: [0, 0, 0] };
  }

  function pageToWorld(side, local, phi) {
    const f = pageFrame(side, phi);
    return add(add(scale(f.u, local[0]), scale(f.v, local[1])), scale(f.n, local[2]));
  }

  function worldToPage(side, p, phi) {
    const f = pageFrame(side, phi);
    return [dot(p, f.u), p[2], dot(p, f.n)];
  }

  // ── Design: points and rigid panels in the open (phi = PI) state ───────────
  class Design {
    constructor(opts) {
      opts = opts || {};
      this.pageWidth = opts.pageWidth || 5;
      this.pageHeight = opts.pageHeight || 7;
      this.points = []; // { pos, glue: 'left'|'right'|'spine'|null, name }
      this.panels = []; // { name, outline, extra, ...style }
    }

    /**
     * Add a point. Points lying on the page surface (y = 0) are glued to the
     * page beneath them unless opts.glue says otherwise.
     * Returns the point id.
     */
    point(pos, opts) {
      opts = opts || {};
      let glue = opts.glue;
      if (glue === undefined) {
        if (Math.abs(pos[1]) < 1e-7) {
          glue = Math.abs(pos[0]) < 1e-7 ? 'spine' : pos[0] < 0 ? 'left' : 'right';
        } else glue = null;
      }
      this.points.push({ pos: pos.slice(), glue: glue || null, name: opts.name || null });
      return this.points.length - 1;
    }

    /**
     * Add a rigid panel. `outline` lists point ids counter-clockwise as seen
     * from the printed (front) side; outline[0] -> outline[1] is the panel's
     * local +u (texture x) direction. `extra` lists ids of points that lie on
     * the panel surface but not on its outline (e.g. a hinge line inside an
     * overhanging roof). Any other properties (color, paint, back, ...) are
     * kept for the renderer.
     */
    panel(spec) {
      const outline = spec.outline.slice();
      if (outline.length < 3) throw new Error('panel needs at least 3 points');
      const panel = Object.assign({}, spec, {
        outline,
        extra: (spec.extra || []).slice(),
        name: spec.name || 'panel' + this.panels.length,
      });
      this.panels.push(panel);
      return panel;
    }

    /** Position of a point in the open design. */
    pos(id) {
      return this.points[id].pos.slice();
    }

    /**
     * A V-fold: the most basic 180° pop-up. Two rigid panels glued to the
     * left and right pages along lines that meet on the spine at `vertex`,
     * joined along a central crease that rises out of the gutter.
     *   vertex:   [0, 0, z] on the spine
     *   gluePtL:  far end of the left glue line (on the left page, x < 0)
     *   gluePtR:  far end of the right glue line (x > 0)
     *   creaseTop: top of the central crease (in the open state)
     * Returns the point ids { vertex, l, r, top }.
     * The panels are triangles; pass `outlineL`/`outlineR` extras to make
     * richer shapes with design.panel directly.
     */
    vfold(spec) {
      const v = this.point(spec.vertex, { glue: 'spine' });
      const l = this.point(spec.gluePtL);
      const r = this.point(spec.gluePtR);
      const top = this.point(spec.creaseTop);
      this.panel(Object.assign({ name: (spec.name || 'vfold') + 'L', outline: [l, v, top] }, spec.styleL || spec.style));
      this.panel(Object.assign({ name: (spec.name || 'vfold') + 'R', outline: [v, r, top] }, spec.styleR || spec.style));
      return { vertex: v, l, r, top };
    }
  }

  // Build a 2D frame for a planar polygon: origin at outline[0], u along the
  // first edge, normal from the polygon's winding (Newell's method).
  function panelFrame(pts) {
    let n = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n = norm(n);
    const u = norm(sub(pts[1], pts[0]));
    const v = cross(n, u);
    return { origin: pts[0], u, v, n };
  }

  // The three points (of `ids`) spanning the largest triangle; `P(id)` gives
  // a point's position. Returns twice the triangle's area.
  function bestTriangle(ids, P) {
    let area = 0, tri = null;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        for (let k = j + 1; k < ids.length; k++) {
          const ar = len(cross(sub(P(ids[j]), P(ids[i])), sub(P(ids[k]), P(ids[i]))));
          if (ar > area) { area = ar; tri = [ids[i], ids[j], ids[k]]; }
        }
    return { tri, area };
  }

  // Solve M x = b in place for symmetric positive-definite M (n x n, dense).
  function choleskySolve(M, b, x, n) {
    for (let j = 0; j < n; j++) {
      let d = M[j * n + j];
      for (let k = 0; k < j; k++) d -= M[j * n + k] * M[j * n + k];
      if (!(d > 0)) return false;
      d = Math.sqrt(d);
      M[j * n + j] = d;
      for (let i = j + 1; i < n; i++) {
        let s = M[i * n + j];
        for (let k = 0; k < j; k++) s -= M[i * n + k] * M[j * n + k];
        M[i * n + j] = s / d;
      }
    }
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= M[i * n + k] * x[k];
      x[i] = s / M[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let k = i + 1; k < n; k++) s -= M[k * n + i] * x[k];
      x[i] = s / M[i * n + i];
    }
    return true;
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  class Simulation {
    constructor(design, opts) {
      opts = opts || {};
      this.design = design;
      this.iterations = opts.iterations || 12;
      this.maxStep = opts.maxStep || (0.5 * Math.PI) / 180;
      this.minAngle = opts.minAngle !== undefined ? opts.minAngle : (0.5 * Math.PI) / 180;
      this.maxAngle = opts.maxAngle !== undefined ? opts.maxAngle : Math.PI;
      this.angle = Math.PI;

      const pts = design.points;
      this.n = pts.length;
      this.pos = new Float64Array(this.n * 3);
      this.glue = pts.map((p) => p.glue);
      this.glueLocal = pts.map((p) => (p.glue ? worldToPage(p.glue, p.pos, Math.PI) : null));
      pts.forEach((p, i) => this.pos.set(p.pos, i * 3));

            this.panels = design.panels.map((panel) => {
        const ids = panel.outline.concat(panel.extra.filter((id) => panel.outline.indexOf(id) < 0));
        const outlinePts = panel.outline.map((id) => pts[id].pos);
        const f = panelFrame(outlinePts);
        const q = ids.map((id) => {
          const d = sub(pts[id].pos, f.origin);
          return [dot(d, f.u), dot(d, f.v), dot(d, f.n)];
        });
        // Check the panel is flat in the design: paper panels are planar.
        let size = 0, offPlane = 0;
        q.forEach((qq) => {
          size = Math.max(size, Math.hypot(qq[0], qq[1]));
          offPlane = Math.max(offPlane, Math.abs(qq[2]));
        });
        if (offPlane > 1e-6 * Math.max(1, size)) {
          throw new Error('panel "' + panel.name + '" is not planar (off by ' + offPlane.toExponential(2) + ')');
        }
        return { panel, ids, q: q.map((qq) => [qq[0], qq[1]]), size, frame: f };
      });
      this._splitStructural();
      this._buildConstraints();
      this._updateGlued(Math.PI);
    }

    // Only "structural" points take part in the solve: points glued to a
    // page, hinge points shared by two or more panels, and enough extra
    // corners to pin down each panel's plane. The rest of a panel's outline
    // (a scalloped tree crown, an eave) cannot change how the mechanism
    // moves, so it is carried along rigidly with its panel afterwards. That
    // keeps the solve tiny however detailed the artwork is.
    _splitStructural() {
      const uses = new Array(this.n).fill(0);
      this.panels.forEach((pp) => pp.ids.forEach((id) => uses[id]++));
      const structural = this.glue.map((g, i) => !!g || uses[i] >= 2);
      const P = (id) => this.design.points[id].pos;
      for (const pp of this.panels) {
        const chosen = pp.ids.filter((id) => structural[id]);
        // Make sure the structural points span the panel's plane.
        const tooSmall = (ids) => bestTriangle(ids, P).area < 1e-6 * pp.size * pp.size;
        while (tooSmall(chosen) || chosen.length < 3) {
          let best = -1, bestScore = -1;
          for (const id of pp.ids) {
            if (chosen.indexOf(id) >= 0) continue;
            const score = chosen.length < 2
              ? chosen.reduce((m, c) => m + len(sub(P(id), P(c))), 0)
              : bestTriangle(chosen.concat([id]), P).area;
            if (score > bestScore) { bestScore = score; best = id; }
          }
          if (best < 0) break;
          chosen.push(best);
          structural[best] = true;
        }
      }
      this.structural = structural;
      this.free = this.glue.map((g, i) => !g && structural[i] && uses[i] > 0);
      for (const pp of this.panels) {
        pp.sub = [];
        pp.dec = [];
        pp.ids.forEach((id, k) => (structural[id] ? pp.sub : this.glue[id] ? [] : pp.dec).push(k));
      }
    }

    _placeDecorative() {
      for (const pp of this.panels) {
        if (!pp.dec.length) continue;
        const goals = this._fit(pp, pp.sub);
        if (!goals) continue;
        for (const k of pp.dec) this.pos.set(goals[k], pp.ids[k] * 3);
      }
    }

    // Rigid-panel constraints. Each panel picks the anchor triangle with the
    // largest area; every other point keeps its distances to the anchor
    // corners and stays in the anchor's plane. Distances alone are not enough
    // for a planar panel (a point can lift off a flat triangle with only a
    // second-order change in length), so the coplanarity term is what keeps
    // card flat. Constraints between glued points only are dropped: the
    // pages already hold those.
    _buildConstraints() {
      const P = (id) => this.design.points[id].pos;
      const cons = [];
      const allPinned = (ids) => ids.every((id) => !this.free[id]);
      for (const pp of this.panels) {
        const ids = pp.sub.map((k) => pp.ids[k]);
        const { tri, area: A } = bestTriangle(ids, P);
        if (!tri || A < 1e-9) throw new Error('panel "' + pp.panel.name + '" has no area');
        const dist = (i, j) => {
          if (allPinned([i, j])) return;
          cons.push({ kind: 'd', i, j, d0: len(sub(P(i), P(j))) });
        };
        dist(tri[0], tri[1]); dist(tri[1], tri[2]); dist(tri[2], tri[0]);
        for (const k of ids) {
          if (tri.indexOf(k) >= 0) continue;
          dist(tri[0], k); dist(tri[1], k); dist(tri[2], k);
          if (!allPinned([tri[0], tri[1], tri[2], k])) {
            cons.push({ kind: 'v', a: tri[0], b: tri[1], c: tri[2], k, s: A });
          }
        }
      }
      this.constraints = cons;
      // Unknowns: the free points.
      this.varOf = new Int32Array(this.n).fill(-1);
      let nv = 0;
      for (let i = 0; i < this.n; i++) if (this.free[i]) this.varOf[i] = nv++;
      this.nVars = nv * 3;
    }

    _updateGlued(phi) {
      for (let i = 0; i < this.n; i++) {
        const g = this.glue[i];
        if (!g) continue;
        const p = pageToWorld(g, this.glueLocal[i], phi);
        this.pos[i * 3] = p[0];
        this.pos[i * 3 + 1] = p[1];
        this.pos[i * 3 + 2] = p[2];
      }
    }

    get(id) {
      return [this.pos[id * 3], this.pos[id * 3 + 1], this.pos[id * 3 + 2]];
    }

    // Best-fit rigid placement of a panel's rest shape onto the current
    // points (Kabsch for a planar shape: a 3x2 polar decomposition).
    // Returns the goal position for each of its points.
    // With `ks`, the fit uses only those indices but goals cover every point.
    _fit(pp, ks) {
      const ids = pp.ids, q = pp.q, P = this.pos;
      if (!ks) ks = ids.map((_, k) => k);
      let W = 0, cx = 0, cy = 0, cz = 0, qx = 0, qy = 0;
      for (const k of ks) {
        const m = 1, i = ids[k] * 3;
        W += m;
        cx += m * P[i]; cy += m * P[i + 1]; cz += m * P[i + 2];
        qx += m * q[k][0]; qy += m * q[k][1];
      }
      cx /= W; cy /= W; cz /= W; qx /= W; qy /= W;
      // A = sum m (p - c)(q - c0)^T, a 3x2 matrix stored by column.
      let a0 = 0, a1 = 0, a2 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (const k of ks) {
        const m = 1, i = ids[k] * 3;
        const dx = P[i] - cx, dy = P[i + 1] - cy, dz = P[i + 2] - cz;
        const du = q[k][0] - qx, dv = q[k][1] - qy;
        a0 += m * dx * du; a1 += m * dy * du; a2 += m * dz * du;
        b0 += m * dx * dv; b1 += m * dy * dv; b2 += m * dz * dv;
      }
      // M = A^T A (2x2 SPD); E = A M^{-1/2} is the nearest orthonormal 3x2.
      const m00 = a0 * a0 + a1 * a1 + a2 * a2;
      const m01 = a0 * b0 + a1 * b1 + a2 * b2;
      const m11 = b0 * b0 + b1 * b1 + b2 * b2;
      const det = m00 * m11 - m01 * m01;
      if (det <= EPS * EPS) return null;
      const s = Math.sqrt(det), t = Math.sqrt(m00 + m11 + 2 * s);
      const s00 = (m00 + s) / t, s01 = m01 / t, s11 = (m11 + s) / t; // sqrt(M)
      const sd = s00 * s11 - s01 * s01;
      const i00 = s11 / sd, i01 = -s01 / sd, i11 = s00 / sd; // sqrt(M)^-1
      const e = [a0 * i00 + b0 * i01, a1 * i00 + b1 * i01, a2 * i00 + b2 * i01];
      const f = [a0 * i01 + b0 * i11, a1 * i01 + b1 * i11, a2 * i01 + b2 * i11];
      const goals = new Array(ids.length);
      for (let k = 0; k < ids.length; k++) {
        const du = q[k][0] - qx, dv = q[k][1] - qy;
        goals[k] = [cx + e[0] * du + f[0] * dv, cy + e[1] * du + f[1] * dv, cz + e[2] * du + f[2] * dv];
      }
      return goals;
    }

    // Keep a point inside the wedge between the two pages (paper cannot pass
    // through a page or out past the spine).
    _wedge(i, phi) {
      const P = this.pos, x = P[i * 3], y = P[i * 3 + 1];
      let th = Math.atan2(y, x);
      if (th < 0) th += 2 * Math.PI;
      if (th <= phi + 1e-12) return false;
      const mid = phi + (2 * Math.PI - phi) / 2;
      if (th < mid) {
        const c = Math.cos(phi), s = Math.sin(phi);
        const t = Math.max(0, x * c + y * s);
        P[i * 3] = t * c;
        P[i * 3 + 1] = t * s;
      } else {
        P[i * 3] = Math.max(0, x);
        P[i * 3 + 1] = 0;
      }
      return true;
    }

    // Residuals r and Jacobian J (dense, constraints x vars).
    _residuals(wantJ) {
      const P = this.pos, cons = this.constraints, nv = this.nVars;
      const r = new Float64Array(cons.length);
      const J = wantJ ? new Float64Array(cons.length * nv) : null;
      const pt = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
      const put = (row, id, g, sc) => {
        const v = this.varOf[id];
        if (v < 0 || !J) return;
        const o = row * nv + v * 3;
        J[o] += g[0] * sc; J[o + 1] += g[1] * sc; J[o + 2] += g[2] * sc;
      };
      for (let c = 0; c < cons.length; c++) {
        const k = cons[c];
        if (k.kind === 'd') {
          const dv = sub(pt(k.i), pt(k.j));
          const L = len(dv) || EPS;
          r[c] = (L - k.d0) / k.d0;
          put(c, k.i, dv, 1 / (L * k.d0));
          put(c, k.j, dv, -1 / (L * k.d0));
        } else {
          const pa = pt(k.a);
          const u = sub(pt(k.b), pa), v = sub(pt(k.c), pa), w = sub(pt(k.k), pa);
          const uv = cross(u, v);
          r[c] = dot(uv, w) / k.s;
          const gb = cross(v, w), gc = cross(w, u);
          put(c, k.k, uv, 1 / k.s);
          put(c, k.b, gb, 1 / k.s);
          put(c, k.c, gc, 1 / k.s);
          put(c, k.a, [-(uv[0] + gb[0] + gc[0]), -(uv[1] + gb[1] + gc[1]), -(uv[2] + gb[2] + gc[2])], 1 / k.s);
        }
      }
      return { r, J };
    }

    _cost(r) {
      let s = 0;
      for (let i = 0; i < r.length; i++) s += r[i] * r[i];
      return s;
    }

    // Levenberg-Marquardt from the current pose. Starting from the previous
    // solution keeps the paper on the branch it is already on.
    _solve(maxIter) {
      const nv = this.nVars, m = this.constraints.length, P = this.pos;
      if (!nv || !m) return 0;
      let { r, J } = this._residuals(true);
      let cost = this._cost(r);
      let lambda = this._lambda || 1e-6;
      const A = new Float64Array(nv * nv), g = new Float64Array(nv), x = new Float64Array(nv);
      const saved = new Float64Array(P.length);
      for (let it = 0; it < maxIter && cost > 1e-26; it++) {
        // Normal equations: (J^T J + lambda diag) dx = -J^T r
        A.fill(0); g.fill(0);
        for (let row = 0; row < m; row++) {
          const o = row * nv, rr = r[row];
          for (let a = 0; a < nv; a++) {
            const ja = J[o + a];
            if (ja === 0) continue;
            g[a] -= ja * rr;
            for (let b = a; b < nv; b++) A[a * nv + b] += ja * J[o + b];
          }
        }
        let improved = false;
        for (let tries = 0; tries < 8 && !improved; tries++) {
          const M = new Float64Array(A);
          for (let a = 0; a < nv; a++) {
            for (let b = 0; b < a; b++) M[a * nv + b] = M[b * nv + a];
            M[a * nv + a] += lambda * (A[a * nv + a] + 1e-9);
          }
          if (!choleskySolve(M, g, x, nv)) { lambda *= 10; continue; }
          saved.set(P);
          for (let i = 0; i < this.n; i++) {
            const v = this.varOf[i];
            if (v < 0) continue;
            P[i * 3] += x[v * 3]; P[i * 3 + 1] += x[v * 3 + 1]; P[i * 3 + 2] += x[v * 3 + 2];
          }
          const next = this._residuals(true);
          const c2 = this._cost(next.r);
          if (c2 < cost) {
            r = next.r; J = next.J; cost = c2;
            lambda = Math.max(1e-12, lambda / 10);
            improved = true;
          } else {
            P.set(saved);
            lambda *= 10;
          }
        }
        if (!improved) break;
      }
      this._lambda = lambda;
      return cost;
    }

    _relax(phi) {
      for (let round = 0; round < 4; round++) {
        this._solve(this.iterations);
        let moved = false;
        for (let i = 0; i < this.n; i++) if (this.free[i]) moved = this._wedge(i, phi) || moved;
        if (!moved) break;
      }
    }

    /**
     * Move the book to opening angle `phi` (radians), folding the paper
     * continuously from wherever it is now.
     */
    setAngle(phi) {
      phi = Math.min(this.maxAngle, Math.max(this.minAngle, phi));
      const steps = Math.max(1, Math.ceil(Math.abs(phi - this.angle) / this.maxStep));
      const start = this.angle;
      for (let s = 1; s <= steps; s++) {
        const a = start + ((phi - start) * s) / steps;
        this._updateGlued(a);
        this._relax(a);
        this.angle = a;
      }
      this._placeDecorative();
      return this;
    }

    /** Settle at the current angle with extra iterations. */
    settle(rounds) {
      for (let r = 0; r < (rounds || 3); r++) this._relax(this.angle);
      this._placeDecorative();
      return this;
    }

    /**
     * How far the paper is from being rigid: the largest distance any point
     * sits from its panel's best rigid placement, relative to that panel's
     * size. ~0 means a buildable card mechanism.
     */
    strain() {
      let worst = 0, worstPanel = null;
      for (const pp of this.panels) {
        const goals = this._fit(pp);
        if (!goals) return { value: Infinity, panel: pp.panel.name };
        for (let k = 0; k < pp.ids.length; k++) {
          const d = len(sub(this.get(pp.ids[k]), goals[k])) / (pp.size || 1);
          if (d > worst) { worst = d; worstPanel = pp.panel.name; }
        }
      }
      return { value: worst, panel: worstPanel };
    }

    /**
     * Paper that has gone through a page: the deepest any panel point sits
     * outside the book (0 when everything is inside), and where.
     */
    outside() {
      const phi = this.angle, c = Math.cos(phi), sn = Math.sin(phi);
      let worst = 0, at = null;
      for (const pp of this.panels) {
        for (const id of pp.ids) {
          if (this.glue[id]) continue;
          const p = this.get(id);
          // inside the wedge means above the right page and in front of the left
          const depth = Math.max(-p[1], -(p[0] * sn - p[1] * c));
          if (depth > worst) { worst = depth; at = pp.panel.name; }
        }
      }
      return { value: worst, panel: at };
    }

    /** Current world positions of a panel's outline points. */
    panelOutline(index) {
      return this.design.panels[index].outline.map((id) => this.get(id));
    }
  }

  return {
    Design,
    Simulation,
    pageFrame,
    pageToWorld,
    worldToPage,
    panelFrame,
    vec: { sub, add, scale, dot, cross, len, norm, lerp },
  };
});
