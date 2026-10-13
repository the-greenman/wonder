/*
 * A layered pop-up tree for a 180° spread.
 *
 * Plan view of the open spread (reader at the bottom, spine vertical):
 *
 *            \   /      back layer: the tall crown
 *          \  \ /  /    middle layer: main crown, with apples
 *        \  \  V  /  /  front layer: trunk and low boughs
 *          \  V  /      grass in front
 *            V
 *
 * Every layer is a V-fold: two panels glued to the pages along short lines
 * that meet at one point on the spine, joined by a vertical centre crease.
 * Each panel is half of a tree silhouette (left half on the left panel,
 * right half on the right), so from the front each layer reads as a flat
 * tree cut-out, bent gently down the middle.
 *
 * All layers use the same glue angle. Layers that are copies of one another
 * shifted along the spine stay copies at every opening angle, so they never
 * cut through each other while the book folds. That is why real layered
 * pop-up scenery is built this way.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PopupTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Half a tree silhouette in (s, v): s is the distance from the centre
  // crease (>= 0), v the height above the page. Starts at the spine vertex,
  // runs along the glue line, up the trunk, round the scalloped crown and
  // finishes at the top of the crease.
  function halfSilhouette(L) {
    if (L.kind === 'hedge') return halfHedge(L);
    const pts = [[0, 0], [L.trunkBase, 0]];
    const W = L.crownWidth, ry = (L.crownTop - L.crownBottom) / 2, cy = L.crownBottom + ry;
    const bump = (th) => 1 + L.scallop * Math.abs(Math.sin(L.lobes * (th + Math.PI / 2) + L.phase));
    // where the crown outline meets the trunk's side
    const th0 = -Math.acos(Math.min(0.98, L.trunkTop / W));
    const N = L.detail || 48;
    for (let i = 0; i <= N; i++) {
      const th = th0 + ((Math.PI / 2 - th0) * i) / N;
      const r = bump(th);
      let s = W * r * Math.cos(th);
      const v = cy + ry * r * Math.sin(th);
      if (i === N) s = 0; // the crown's top sits on the crease
      pts.push([s, v]);
    }
    return pts;
  }

  // A low scalloped hedge of grass, glued along its whole foot.
  function halfHedge(L) {
    const w = L.width, h = L.height, N = L.detail || 40;
    const pts = [[0, 0], [w, 0], [w, h * 0.35]];
    for (let i = 1; i <= N; i++) {
      const s = w * (1 - i / N);
      const t = 1 - s / w; // 0 at the outer end, 1 at the crease
      const tuft = Math.sqrt(Math.abs(Math.sin(L.lobes * Math.PI * t + L.phase)));
      pts.push([s, h * (0.35 + 0.45 * Math.sqrt(t) + 0.2 * tuft)]);
    }
    pts[pts.length - 1][0] = 0;
    return pts;
  }

  // Layer recipes. Glue lines are kept short (the trunk's foot) so the
  // panels hinge as one V-fold.
  const LAYERS = [
    { name: 'grass', kind: 'hedge', z: 1.75, width: 1.35, height: 0.55, lobes: 5, phase: 0.4 },
    { name: 'front', z: 0.85, trunkBase: 0.3, trunkTop: 0.18, crownBottom: 1.15, crownTop: 2.65, crownWidth: 1.3, lobes: 4, scallop: 0.12, phase: 0.6 },
    { name: 'middle', z: 0.0, trunkBase: 0.16, trunkTop: 0.1, crownBottom: 1.45, crownTop: 3.3, crownWidth: 1.5, lobes: 5, scallop: 0.1, phase: 0.2 },
    { name: 'back', z: -0.85, trunkBase: 0.12, trunkTop: 0.08, crownBottom: 1.9, crownTop: 3.95, crownWidth: 1.3, lobes: 4, scallop: 0.11, phase: 1.1 },
  ];

  function buildTree(Popup, opts) {
    opts = opts || {};
    const V = Popup.vec;
    const d = new Popup.Design({ pageWidth: 5, pageHeight: 7 });
    const S = opts.styles || {};
    // Angle between each glue line and the spine. 90° would lay both halves
    // in one plane (no fold); smaller angles fold deeper. 62° leaves each
    // layer facing the reader, bent by 56° down its middle.
    const glue = (opts.glueAngle || 62) * Math.PI / 180;
    const dirL = [-Math.sin(glue), 0, -Math.cos(glue)];
    const dirR = [Math.sin(glue), 0, -Math.cos(glue)];
    const up = [0, 1, 0];

    const layers = (opts.layers || LAYERS).map((L) => {
      const half = halfSilhouette(L);
      const vertex = [0, 0, L.z];
      const at = (dir, s, v) => V.add(vertex, V.add(V.scale(dir, s), V.scale(up, v)));

      // Shared: the spine vertex and the top of the crease.
      const top = half[half.length - 1];
      const vId = d.point(vertex, { glue: 'spine' });
      const topId = d.point(at(up, 0, top[1]), { glue: null });
      const side = (dir) => half.map(([s, v], i) => {
        if (i === 0) return vId;
        if (i === half.length - 1) return topId;
        return d.point(at(dir, s, v), i === 1 ? undefined : { glue: null }); // i = 1 is the glue end
      });
      const idsL = side(dirL), idsR = side(dirR);

      // Right half as listed is counter-clockwise seen from the front. The
      // left half is its mirror image, so reverse it, keeping the glue line
      // as the first edge (from the glue end to the vertex).
      const outlineR = idsR;
      const outlineL = [idsL[1], idsL[0]].concat(idsL.slice(2).reverse());
      const info = { layer: L.name, recipe: L, half };
      d.panel(Object.assign({ name: L.name + '-left', outline: outlineL, side: 'left', info }, S[L.name]));
      d.panel(Object.assign({ name: L.name + '-right', outline: outlineR, side: 'right', info }, S[L.name]));
      return { name: L.name, vertex: vId, top: topId, recipe: L };
    });

    d.meta = { layers, glueAngle: glue };
    return d;
  }

  return { buildTree, halfSilhouette, LAYERS };
});
