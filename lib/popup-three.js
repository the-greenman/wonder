/*
 * popup-three.js — draws a Popup.Simulation with three.js (r128+).
 *
 *   const view = PopupThree.createView(THREE, sim, options);
 *   scene.add(view.root);
 *   // each frame, after sim.setAngle(...):
 *   view.update();
 *
 * Panels may carry style properties (set in the design):
 *   color: '#hex'          printed-side colour
 *   back:  '#hex'          plain card colour on the reverse
 *   paint(ctx, box)        draw the printed side in panel units; box has
 *                          {minU, maxU, minV, maxV, outline: [[u,v],...], panel}.
 *                          +u runs along the panel's first edge, +v is "up".
 * Options:
 *   paintSpread(ctx, box)  draw both pages, in open-spread world units:
 *                          u = x (left page negative), v = -z (up = away from
 *                          the reader)
 *   coverColor, pageColor, paintCover(ctx, box)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PopupThree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PX_PER_UNIT = 220;
  const MAX_TEX = 2048;

  function canvasTexture(THREE, renderer, w, h, minU, maxU, minV, maxV, draw) {
    const ppu = Math.min(PX_PER_UNIT, MAX_TEX / Math.max(w, h));
    const cw = Math.max(4, Math.round(w * ppu)), ch = Math.max(4, Math.round(h * ppu));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    // Panel units, +v up.
    ctx.setTransform(cw / w, 0, 0, -ch / h, -minU * (cw / w), maxV * (ch / h));
    draw(ctx);
    const tex = new THREE.CanvasTexture(canvas);
    if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /** Draw text the right way up inside a +v-up panel transform. */
  function text(ctx, str, u, v, size, opts) {
    opts = opts || {};
    ctx.save();
    ctx.translate(u, v);
    ctx.scale(1, -1);
    // Fonts are sized in panel units; draw at 100px and scale down.
    const k = size / 100;
    ctx.scale(k, k);
    ctx.font = (opts.style || '') + ' ' + (opts.weight || '') + ' 100px ' + (opts.family || 'Georgia, serif');
    ctx.textAlign = opts.align || 'center';
    ctx.textBaseline = opts.baseline || 'alphabetic';
    ctx.fillStyle = opts.color || '#000';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  function createView(THREE, sim, options) {
    options = options || {};
    const renderer = options.renderer || null;
    const design = sim.design;
    const PW = design.pageWidth, PH = design.pageHeight;
    const BLOCK = options.blockThickness || 0.1; // page block under each page
    const BOARD = options.boardThickness || 0.07;
    const MARGIN = options.coverMargin || 0.18;

    const root = new THREE.Group();

    // ── pages ────────────────────────────────────────────────────────────────
    const spreadTex = canvasTexture(THREE, renderer, 2 * PW, PH, -PW, PW, -PH / 2, PH / 2, (ctx) => {
      ctx.fillStyle = options.pageColor || '#f3ead2';
      ctx.fillRect(-PW, -PH / 2, 2 * PW, PH);
      if (options.paintSpread) options.paintSpread(ctx, { minU: -PW, maxU: PW, minV: -PH / 2, maxV: PH / 2 });
    });

    function pageMesh(x0, x1) {
      const g = new THREE.PlaneGeometry(x1 - x0, PH);
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, 0, 0);
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) + PW) / (2 * PW), (-pos.getZ(i) + PH / 2) / PH);
      }
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        map: spreadTex, roughness: 0.92, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      m.receiveShadow = true;
      return m;
    }

    const paperEdge = new THREE.MeshStandardMaterial({ color: options.edgeColor || '#e9dfc4', roughness: 0.95 });
    const coverMat = new THREE.MeshStandardMaterial({ color: options.coverColor || '#7a2a22', roughness: 0.8 });

    function block(sign) {
      // the page block sits just under the printed surface
      // (kept clear of the printed surface so the two never fight for depth)
      const g = new THREE.BoxGeometry(PW, BLOCK - 0.02, PH);
      const m = new THREE.Mesh(g, paperEdge);
      m.position.set((sign * PW) / 2, -BLOCK / 2 - 0.01, 0);
      m.castShadow = true; m.receiveShadow = true;
      return m;
    }

    function board(sign, outerMat) {
      const g = new THREE.BoxGeometry(PW + MARGIN, BOARD, PH + 2 * MARGIN);
      const mats = [coverMat, coverMat, coverMat, outerMat || coverMat, coverMat, coverMat];
      const m = new THREE.Mesh(g, mats);
      m.position.set((sign * (PW + MARGIN)) / 2, -BLOCK - BOARD / 2, 0);
      m.castShadow = true; m.receiveShadow = true;
      return m;
    }

    let frontCoverMat = null;
    if (options.paintCover) {
      const w = PW + MARGIN, h = PH + 2 * MARGIN;
      const tex = canvasTexture(THREE, renderer, w, h, 0, w, 0, h, (ctx) => {
        ctx.fillStyle = options.coverColor || '#7a2a22';
        ctx.fillRect(0, 0, w, h);
        // the board's outer face is mapped upside down: turn the art round
        // so +v is the top of the closed book
        ctx.translate(w, h);
        ctx.rotate(Math.PI);
        options.paintCover(ctx, { minU: 0, maxU: w, minV: 0, maxV: h });
      });
      frontCoverMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 });
    }

    const right = new THREE.Group();
    right.add(pageMesh(0, PW), block(1), board(1));
    root.add(right);

    const left = new THREE.Group();
    left.add(pageMesh(-PW, 0), block(-1), board(-1, frontCoverMat));
    root.add(left);

    // ── spine: a curved strip joining the boards round the gutter ───────────
    const SPINE_SEG = 20;
    const spineR = BLOCK + BOARD;
    const spineGeo = new THREE.BufferGeometry();
    const spinePos = new Float32Array((SPINE_SEG + 1) * 2 * 3);
    const spineIdx = [];
    for (let i = 0; i < SPINE_SEG; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      spineIdx.push(a, c, b, b, c, d);
    }
    spineGeo.setIndex(spineIdx);
    spineGeo.setAttribute('position', new THREE.BufferAttribute(spinePos, 3));
    const spine = new THREE.Mesh(spineGeo, new THREE.MeshStandardMaterial({ color: options.coverColor || '#7a2a22', roughness: 0.8, side: THREE.DoubleSide }));
    spine.castShadow = true;
    root.add(spine);

    function updateSpine(phi) {
      // from the right board's outside (pointing down) round the back of the
      // gutter to the left board's outside
      const a0 = Math.PI / 2 + phi, a1 = 1.5 * Math.PI;
      const zh = PH / 2 + MARGIN;
      for (let i = 0; i <= SPINE_SEG; i++) {
        const a = a0 + ((a1 - a0) * i) / SPINE_SEG;
        const x = spineR * Math.cos(a), y = spineR * Math.sin(a);
        spinePos.set([x, y, -zh, x, y, zh], i * 6);
      }
      spineGeo.attributes.position.needsUpdate = true;
      spineGeo.computeVertexNormals();
      spineGeo.computeBoundingSphere();
    }

    // ── pop-up panels ────────────────────────────────────────────────────────
    const panels = sim.panels.map((pp) => {
      const panel = pp.panel;
      const nOut = panel.outline.length;
      const q = pp.q.slice(0, nOut); // outline coordinates in panel units
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      q.forEach(([u, v]) => {
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      });
      const w = maxU - minU || 1, h = maxV - minV || 1;
      const tris = THREE.ShapeUtils.triangulateShape(q.map(([u, v]) => new THREE.Vector2(u, v)), []);
      const index = [];
      tris.forEach((t) => index.push(t[0], t[1], t[2]));

      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(nOut * 3);
      const uv = new Float32Array(nOut * 2);
      q.forEach(([u, v], i) => {
        uv[i * 2] = (u - minU) / w;
        uv[i * 2 + 1] = (v - minV) / h;
      });
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(index);
      // Make sure the front side is the printed side (CCW from the front).
      const a = q[index[0]], b = q[index[1]], c = q[index[2]];
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (area < 0) {
        for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
        geo.setIndex(index);
      }

      let map = null;
      if (panel.paint) {
        map = canvasTexture(THREE, renderer, w, h, minU, maxU, minV, maxV, (ctx) => {
          ctx.fillStyle = panel.color || '#f7f1e3';
          ctx.fillRect(minU, minV, w, h);
          panel.paint(ctx, { minU, maxU, minV, maxV, outline: q, panel });
        });
      }
      const front = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: map ? '#ffffff' : panel.color || '#f7f1e3', map, roughness: 0.85, side: THREE.FrontSide,
      }));
      const back = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: panel.back || '#efe6cf', roughness: 0.92, side: THREE.BackSide,
      }));
      front.castShadow = back.castShadow = true;
      front.receiveShadow = back.receiveShadow = true;
      root.add(front, back);
      return { pp, geo, pos, ids: panel.outline };
    });

    function update() {
      const phi = sim.angle;
      left.rotation.z = phi - Math.PI;
      updateSpine(phi);
      panels.forEach((p) => {
        p.ids.forEach((id, i) => {
          p.pos[i * 3] = sim.pos[id * 3];
          p.pos[i * 3 + 1] = sim.pos[id * 3 + 1];
          p.pos[i * 3 + 2] = sim.pos[id * 3 + 2];
        });
        p.geo.attributes.position.needsUpdate = true;
        p.geo.computeVertexNormals();
        p.geo.computeBoundingSphere();
      });
    }

    update();
    return { root, update, left, right };
  }

  return { createView, text };
});
