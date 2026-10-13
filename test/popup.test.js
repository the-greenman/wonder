// Run: node test/popup.test.js
'use strict';
const assert = require('assert');
const Popup = require('../lib/popup.js');
const { buildHouse } = require('../designs/house.js');
const { buildTree } = require('../designs/tree.js');

const DEG = Math.PI / 180;
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + '\n     ' + e.message);
  }
}

// Every point of the paper that is not glued down (hinges and outline alike).
function freeIds(sim) {
  const ids = new Set();
  sim.panels.forEach((pp) => pp.ids.forEach((id) => { if (!sim.glue[id]) ids.add(id); }));
  return Array.from(ids);
}

// Signed distance of a point from each page's printed side (>= 0 inside the book).
function insideBook(p, phi) {
  const r = p[1]; // right page normal is +y
  const l = p[0] * Math.sin(phi) - p[1] * Math.cos(phi);
  return Math.min(r, l);
}

test('page frames: closed book has the left page face-down on the right page', () => {
  const f0 = Popup.pageFrame('left', 0);
  assert.deepStrictEqual(f0.u.map(Math.round), [1, 0, 0]);
  assert.deepStrictEqual(f0.n.map(Math.round), [0, -1, 0]);
  const f90 = Popup.pageFrame('left', 90 * DEG);
  assert.deepStrictEqual(f90.u.map(Math.round), [0, 1, 0], 'at 90° the left page stands up');
  const f180 = Popup.pageFrame('left', Math.PI);
  assert.deepStrictEqual(f180.u.map(Math.round), [-1, 0, 0]);
  assert.deepStrictEqual(f180.n.map(Math.round), [0, 1, 0], 'open: printed side faces up');
});

test('a single V-fold folds flat and stands back up, rigidly', () => {
  const d = new Popup.Design();
  const k = Math.SQRT1_2;
  d.vfold({ vertex: [0, 0, 1], gluePtL: [-k, 0, 1 - k], gluePtR: [k, 0, 1 - k], creaseTop: [0, 1, 1] });
  const sim = new Popup.Simulation(d);
  const top = 3;
  for (let a = 180; a >= 1; a -= 1) {
    sim.setAngle(a * DEG);
    assert(sim.strain().value < 1e-9, 'strain at ' + a + '°: ' + sim.strain().value);
  }
  sim.setAngle(90 * DEG);
  const p = sim.get(top);
  // Analytic V-fold: with 45° glue lines and a 90° crease sector, the crease
  // top at a 90° spread lies along the bisector of the two pages.
  assert(p[1] > 0.3 && p[0] > 0.3, 'crease rises between the pages, got ' + p.map((x) => x.toFixed(3)));
  sim.setAngle(Math.PI);
  assert(Popup.vec.len(Popup.vec.sub(sim.get(top), [0, 1, 1])) < 1e-3, 'returns to the design when reopened');
});

test('house: open design is rigid and every face points out', () => {
  const d = buildHouse(Popup);
  const sim = new Popup.Simulation(d);
  assert(sim.strain().value < 1e-9);
  const centre = [0, d.meta.H / 2, d.meta.zMid];
  d.panels.forEach((p) => {
    const pts = p.outline.map((id) => d.pos(id));
    const n = Popup.panelFrame(pts).n;
    const c = pts.reduce((s, q) => Popup.vec.add(s, q), [0, 0, 0]).map((x) => x / pts.length);
    if (p.name.startsWith('chimney')) assert(n[2] > 0, p.name + ' faces the reader');
    else assert(Popup.vec.dot(n, Popup.vec.sub(c, centre)) > 0, p.name + ' faces out');
  });
});

test('house: closes flat inside the book, never through a page, and reopens', () => {
  const d = buildHouse(Popup);
  const sim = new Popup.Simulation(d);
  const ids = freeIds(sim);
  let worstStrain = 0, worstAt = 0;
  for (let a = 180; a >= 1; a -= 0.5) {
    sim.setAngle(a * DEG);
    const s = sim.strain().value;
    if (s > worstStrain) { worstStrain = s; worstAt = a; }
    ids.forEach((i) => assert(insideBook(sim.get(i), a * DEG) > -1e-6, 'point ' + i + ' outside the book at ' + a + '°'));
  }
  assert(worstStrain < 1e-9, 'paper strain ' + worstStrain.toExponential(2) + ' at ' + worstAt + '°');

  // Closed: everything lies flat, within the page.
  sim.setAngle(sim.minAngle).settle(20);
  let maxY = 0;
  ids.forEach((i) => {
    const p = sim.get(i);
    maxY = Math.max(maxY, p[1]);
    assert(p[0] >= -1e-6 && p[0] <= d.pageWidth, 'x within the page: ' + p[0]);
    assert(Math.abs(p[2]) <= d.pageHeight / 2, 'z within the page: ' + p[2]);
  });
  assert(maxY < 0.05, 'flat when closed, max height ' + maxY);

  // Halfway: the house is up off the page, walls between the pages.
  sim.setAngle(90 * DEG);
  const apex = sim.get(d.meta.front.apex);
  assert(insideBook(apex, 90 * DEG) > 0.5, 'roof is clear of both pages at 90°');

  // Open again: back to the design.
  sim.setAngle(Math.PI).settle(40);
  let err = 0;
  d.points.forEach((pt, i) => (err = Math.max(err, Popup.vec.len(Popup.vec.sub(sim.get(i), pt.pos)))));
  assert(err < 1e-6, 'reopened house matches the design, max error ' + err);
});

test('house: front and back halves meet at the side corners only when open', () => {
  const d = buildHouse(Popup);
  const sim = new Popup.Simulation(d);
  const f = d.meta.front.leftTop, b = d.meta.back.leftTop;
  assert(f !== b, 'separate pieces');
  const gap = () => Popup.vec.len(Popup.vec.sub(sim.get(f), sim.get(b)));
  assert(gap() < 1e-9);
  sim.setAngle(120 * DEG);
  assert(gap() > 0.05, 'halves part as the book closes');
});

test('strain flags a design that cannot fold rigidly', () => {
  // A box straddling the gutter with its walls square to the spine is a
  // classic design that only works because card flexes; rigid card locks.
  const d = new Popup.Design();
  const k = Math.SQRT1_2;
  const vF = d.point([0, 0, 1], { glue: 'spine' }), vB = d.point([0, 0, 1 - 2 * k], { glue: 'spine' });
  const L = d.point([-k, 0, 1 - k]), R = d.point([k, 0, 1 - k]);
  const tF = d.point([0, 1, 1]), tB = d.point([0, 1, 1 - 2 * k]);
  const tL = d.point([-k, 1, 1 - k]), tR = d.point([k, 1, 1 - k]);
  // walls hinged to each other at the side corners (shared L/tL, R/tR)
  d.panel({ outline: [L, vF, tF, tL] });
  d.panel({ outline: [vF, R, tR, tF] });
  d.panel({ outline: [vB, L, tL, tB] });
  d.panel({ outline: [R, vB, tB, tR] });
  const sim = new Popup.Simulation(d);
  sim.setAngle(120 * DEG);
  assert(sim.strain().value > 0.02, 'expected visible strain, got ' + sim.strain().value);
});

test('tree: layered V-folds fold flat rigidly, inside the book, and reopen', () => {
  const d = buildTree(Popup);
  const sim = new Popup.Simulation(d);
  // Only hinge points are solved; the crown outlines ride along rigidly.
  assert(sim.nVars <= 3 * d.meta.layers.length, 'solved unknowns: ' + sim.nVars);
  let worst = 0;
  for (let a = 180; a >= 1; a -= 0.5) {
    sim.setAngle(a * DEG);
    worst = Math.max(worst, sim.strain().value);
    assert(sim.outside().value < 1e-9, 'paper through a page at ' + a + '°: ' + JSON.stringify(sim.outside()));
  }
  assert(worst < 1e-9, 'paper strain ' + worst);
  sim.setAngle(sim.minAngle);
  freeIds(sim).forEach((i) => {
    const p = sim.get(i);
    assert(p[1] < 0.05 && p[0] <= d.pageWidth && Math.abs(p[2]) <= d.pageHeight / 2, 'closed flat inside the page: ' + p);
  });
  sim.setAngle(Math.PI);
  let err = 0;
  d.points.forEach((pt, i) => (err = Math.max(err, Popup.vec.len(Popup.vec.sub(sim.get(i), pt.pos)))));
  assert(err < 1e-6, 'reopened tree matches the design, max error ' + err);
});

test('tree: layers stay parallel, so they never cut through each other', () => {
  const d = buildTree(Popup);
  const sim = new Popup.Simulation(d);
  const normalOf = (name) => {
    const p = d.panels.find((q) => q.name === name);
    return Popup.panelFrame(p.outline.map((id) => sim.get(id))).n;
  };
  const names = d.meta.layers.map((l) => l.name);
  for (const a of [150, 100, 45, 10]) {
    sim.setAngle(a * DEG);
    for (const side of ['left', 'right']) {
      const n0 = normalOf(names[0] + '-' + side);
      names.slice(1).forEach((nm) => {
        const n = normalOf(nm + '-' + side);
        assert(Popup.vec.len(Popup.vec.cross(n0, n)) < 1e-9, nm + '-' + side + ' parallel to ' + names[0] + ' at ' + a + '°');
      });
    }
  }
});

if (failures) {
  console.log('\n' + failures + ' failed');
  process.exit(1);
}
console.log('\nall passed');
