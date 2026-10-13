/*
 * A pop-up house for a 180° spread, built only from rigid card folds.
 *
 * Plan view of the open spread (reader at the bottom, spine vertical):
 *
 *                 back corner  (on the spine)
 *                    /\
 *          back-L   /  \   back-R        back half: a V-fold pointing away
 *                  /    \
 *      left corner <      > right corner (the halves meet here when open)
 *                  \    /
 *          front-L  \  /   front-R       front half: a V-fold pointing at you
 *                    \/
 *                 front corner (on the spine)
 *
 * Each half is a V-fold (two walls glued along lines through one spine point)
 * carrying half of a pyramid roof on a hinge at the wall tops. Each half is a
 * one-degree-of-freedom mechanism, so it folds flat as the book closes and
 * stands up as it opens. The two halves are separate pieces that touch at the
 * side corners only when the book is fully open, like a real paper-engineered
 * house. The front door faces the reader on the front-right wall.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PopupHouse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function buildHouse(Popup, opts) {
    opts = opts || {};
    const V = Popup.vec;
    const d = new Popup.Design({ pageWidth: 5, pageHeight: 7 });

    const WALL = opts.wallWidth || 1.9; // width of each wall
    const H = opts.wallHeight || 1.45; // wall height
    const RISE = opts.roofRise || 1.05; // roof apex above the wall tops
    const EAVE = opts.eave || 0.14; // roof overhang, as a fraction of the roof
    const zFront = opts.frontZ !== undefined ? opts.frontZ : 1.45; // front corner on the spine
    const a = Math.SQRT1_2;
    const diag = WALL * a;

    const zBack = zFront - 2 * diag; // back corner on the spine
    const zMid = zFront - diag; // house centre
    const centre = [0, H / 2, zMid];
    const apexPos = [0, H + RISE, zMid];

    const up = (p, h) => [p[0], p[1] + h, p[2]];
    const leftPos = [-diag, 0, zMid];
    const rightPos = [diag, 0, zMid];

    // Shared paint styles (the renderer calls these; Node never does).
    const S = opts.styles || {};

    // Order a polygon's ids so its printed side faces away from `from`.
    // Reversing keeps the first edge first (walls start with their bottom
    // edge, roofs with their eave), so textures stay upright.
    function outward(ids, from) {
      const pts = ids.map((id) => d.pos(id));
      const f = Popup.panelFrame(pts);
      const c = pts.reduce((s, p) => V.add(s, p), [0, 0, 0]).map((x) => x / pts.length);
      if (V.dot(f.n, V.sub(c, from)) >= 0) return ids;
      return [ids[1], ids[0]].concat(ids.slice(2).reverse());
    }

    // One half of the house: a V-fold of two walls plus a two-faced roof cap.
    // Every half has its own points, so the halves are separate pieces.
    function half(tag, spineZ) {
      const vertex = d.point([0, 0, spineZ], { glue: 'spine' });
      const crease = d.point(up(d.pos(vertex), H), { glue: null });
      const left = d.point(leftPos); // glued to the left page
      const leftTop = d.point(up(leftPos, H), { glue: null });
      const right = d.point(rightPos); // glued to the right page
      const rightTop = d.point(up(rightPos, H), { glue: null });

      const wl = d.panel(Object.assign({ name: tag + '-wall-left', outline: outward([left, vertex, crease, leftTop], centre) }, S[tag + 'WallLeft']));
      const wr = d.panel(Object.assign({ name: tag + '-wall-right', outline: outward([vertex, right, rightTop, crease], centre) }, S[tag + 'WallRight']));

      // Roof: two triangles meeting along the hip over the crease, each
      // hinged to its wall's top edge and overhanging by EAVE.
      const apex = d.point(apexPos, { glue: null });
      const grow = (id) => V.add(apexPos, V.scale(V.sub(d.pos(id), apexPos), 1 + EAVE));
      const eaveCorner = d.point(grow(crease), { glue: null });
      const eaveL = d.point(grow(leftTop), { glue: null });
      const eaveR = d.point(grow(rightTop), { glue: null });
      const rl = d.panel(Object.assign({ name: tag + '-roof-left', outline: outward([eaveL, eaveCorner, apex], centre), extra: [leftTop, crease] }, S.roof));
      const rr = d.panel(Object.assign({ name: tag + '-roof-right', outline: outward([eaveCorner, eaveR, apex], centre), extra: [crease, rightTop] }, S.roof));
      return { vertex, crease, apex, leftTop, rightTop, wallLeft: wl, wallRight: wr, roofLeft: rl, roofRight: rr };
    }

    const front = half('front', zFront);
    const back = half('back', zBack);

    // A chimney: a little V-fold standing on the front roof's hip, glued to
    // the two roof faces, showing that pop-ups can stand on pop-ups.
    if (opts.chimney !== false) {
      const hipFrom = d.pos(front.crease), hipTo = apexPos;
      const base = V.lerp(hipFrom, hipTo, 0.6);
      const baseId = d.point(base, { glue: null }); // on the hip: in both faces
      const rl = front.roofLeft, rr = front.roofRight;
      const nL = Popup.panelFrame(rl.outline.map((id) => d.pos(id))).n;
      const nR = Popup.panelFrame(rr.outline.map((id) => d.pos(id))).n;
      // Glue lines run across each roof face, square to the hip.
      const hipDir = V.norm(V.sub(hipTo, hipFrom));
      const across = (n, sign) => {
        const v = V.norm(V.cross(n, hipDir));
        return v[0] * sign >= 0 ? v : V.scale(v, -1);
      };
      const w = 0.24, ch = 0.62;
      const pl = V.add(base, V.scale(across(nL, -1), w));
      const pr = V.add(base, V.scale(across(nR, 1), w));
      const plId = d.point(pl, { glue: null });
      const prId = d.point(pr, { glue: null });
      rl.extra.push(baseId, plId);
      rr.extra.push(baseId, prId);
      // Chimney walls stand vertical in the open state and face the reader.
      const top = d.point(up(base, ch), { glue: null });
      const tl = d.point(up(pl, ch), { glue: null });
      const tr = d.point(up(pr, ch), { glue: null });
      const behind = [base[0], base[1], base[2] - 1];
      d.panel(Object.assign({ name: 'chimney-left', outline: outward([plId, baseId, top, tl], behind) }, S.chimney));
      d.panel(Object.assign({ name: 'chimney-right', outline: outward([baseId, prId, tr, top], behind) }, S.chimney));
    }

    d.meta = { front, back, zFront, zBack, zMid, H, WALL, diag, apex: apexPos };
    return d;
  }

  return { buildHouse };
});
