/*
 * popup-stage.js — the demo stage shared by the example pages: a lit table,
 * an orbit camera, the open/close button and slider, and the render loop.
 *
 *   PopupStage.mount({
 *     design,                 // a Popup.Design
 *     paintSpread, paintCover, coverColor,   // passed to PopupThree.createView
 *     fonts: ['italic 100px "Playfair Display"'],  // canvas fonts to wait for
 *   });
 *
 * Expects the page to contain #toggle (button), #angle (range 0..180) and
 * #readout, and three.js, popup.js and popup-three.js to be loaded.
 */
(function (root) {
  'use strict';
  const DEG = Math.PI / 180;

  /** Small seeded random generator for repeatable artwork. */
  function rng(seed) {
    return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  }

  function mount(opts) {
    const design = opts.design;

    // ── Scene ────────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#14100a');
    const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 200);

    scene.add(new THREE.HemisphereLight('#fff3dc', '#3a2a18', 0.55));
    const sun = new THREE.DirectionalLight('#fff1d6', 1.05);
    sun.position.set(-5, 11, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const rim = new THREE.DirectionalLight('#a9c4ff', 0.25);
    rim.position.set(6, 4, -8);
    scene.add(rim);

    const table = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#3b2615', roughness: 0.9 }));
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.18;
    table.receiveShadow = true;
    scene.add(table);

    // ── The pop-up ───────────────────────────────────────────────────────────
    const sim = new Popup.Simulation(design, { maxStep: 1 * DEG });
    let view;
    const fontsReady = document.fonts && opts.fonts
      ? Promise.race([
          Promise.all(opts.fonts.map((f) => document.fonts.load(f))),
          new Promise((r) => setTimeout(r, 1500)),
        ])
      : Promise.resolve();

    fontsReady.then(() => {
      view = PopupThree.createView(THREE, sim, {
        renderer,
        paintSpread: opts.paintSpread,
        paintCover: opts.paintCover,
        coverColor: opts.coverColor,
      });
      scene.add(view.root);
      // Fold the design shut (it is authored open) so the book starts closed.
      sim.setAngle(0);
      view.update();
      if (opts.autoOpen !== false) setTimeout(() => animateTo(180), 700);
    });

    // ── Opening and closing ──────────────────────────────────────────────────
    const toggle = document.getElementById('toggle');
    const slider = document.getElementById('angle');
    const readout = document.getElementById('readout');
    let tween = null;

    function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

    function animateTo(deg) {
      const from = sim.angle / DEG;
      tween = { from, to: deg, start: performance.now(), dur: 400 + Math.abs(deg - from) * 14 };
    }

    toggle.addEventListener('click', () => {
      const target = tween ? tween.to : sim.angle / DEG;
      animateTo(target > 90 ? 0 : 180);
    });
    slider.addEventListener('input', () => {
      tween = null;
      sim.setAngle(parseFloat(slider.value) * DEG);
    });

    function syncUi() {
      const deg = sim.angle / DEG;
      slider.value = deg.toFixed(1);
      const going = tween ? tween.to : deg;
      toggle.textContent = going > 90 ? 'Close the book' : 'Open the book';
      const s = sim.strain().value;
      readout.textContent = (deg < 0.6 ? 'closed' : Math.round(deg) + '° open') + ' · paper strain ' + (s < 1e-6 ? '0' : (s * 100).toFixed(2) + '%');
    }

    // ── Camera ───────────────────────────────────────────────────────────────
    const R0 = opts.cameraDistance || 15.5;
    const orbit = { az: 0.42, el: 0.62, r: R0, target: new THREE.Vector3(0.3, opts.lookHeight || 0.6, 0.2) };
    function placeCamera() {
      // look at the middle of the book: the closed book sits on the right half
      orbit.target.x = 0.3 + (design.pageWidth / 2 - 0.3) * (1 - Math.min(1, sim.angle / (100 * DEG)));
      orbit.el = Math.min(1.45, Math.max(0.08, orbit.el));
      orbit.r = Math.min(40, Math.max(5, orbit.r));
      camera.position.set(
        orbit.target.x + orbit.r * Math.cos(orbit.el) * Math.sin(orbit.az),
        orbit.target.y + orbit.r * Math.sin(orbit.el),
        orbit.target.z + orbit.r * Math.cos(orbit.el) * Math.cos(orbit.az)
      );
      camera.lookAt(orbit.target);
    }
    function fit() {
      camera.aspect = window.innerWidth / window.innerHeight;
      // keep the open spread in view on narrow screens
      orbit.r = Math.max(orbit.r, camera.aspect < 1 ? (R0 / camera.aspect) * 0.9 : R0);
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      placeCamera();
    }
    const cvs = renderer.domElement;
    let drag = null;
    cvs.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; cvs.setPointerCapture(e.pointerId); });
    cvs.addEventListener('pointerup', () => (drag = null));
    cvs.addEventListener('pointermove', (e) => {
      if (!drag) return;
      orbit.az -= (e.clientX - drag.x) * 0.006;
      orbit.el += (e.clientY - drag.y) * 0.004;
      drag = { x: e.clientX, y: e.clientY };
      placeCamera();
    });
    cvs.addEventListener('wheel', (e) => { e.preventDefault(); orbit.r *= Math.exp(e.deltaY * 0.001); placeCamera(); }, { passive: false });
    window.addEventListener('resize', fit);
    fit();

    // ── Loop ─────────────────────────────────────────────────────────────────
    function frame(now) {
      requestAnimationFrame(frame);
      if (view) {
        if (tween) {
          const t = Math.min(1, (now - tween.start) / tween.dur);
          sim.setAngle((tween.from + (tween.to - tween.from) * ease(t)) * DEG);
          if (t >= 1) tween = null;
        }
        view.update();
        placeCamera();
        syncUi();
      }
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);

    const stage = { sim, design, scene, camera, renderer, animateTo, orbit, placeCamera, get view() { return view; } };
    window.__popup = stage; // handy for debugging and screenshots
    return stage;
  }

  root.PopupStage = { mount, rng };
})(typeof self !== 'undefined' ? self : this);
