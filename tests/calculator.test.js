// Joint calculator against the worked example in the RTG standard (EP 800/4, 1000 mm).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../shared/logic.js');

test('EP 800/4, 1000 mm, 6 + 2 covers matches the worked example', () => {
  const r = L.jointCalc({ belt: 'ep800/4', width: 1000, top: 6, bottom: 2, carcass: 4.5, cooling: 'water' });
  assert.strictEqual(r.plyRating, 200);
  assert.strictEqual(r.step.step, 250);
  assert.strictEqual(r.steps, 3);
  assert.strictEqual(r.overlapLength, 750);
  assert.strictEqual(r.biasLength, 300);
  assert.strictEqual(r.totalLength, 1050);
  assert.deepStrictEqual(r.platen.width, [1150, 1200]);
  assert.strictEqual(r.platen.rhombic.required, 950);
  assert.strictEqual(r.platen.rhombic.length, 1000, 'two 500 mm sections');
  assert.strictEqual(r.platen.rectangular.length, 1250);
  assert.deepStrictEqual(r.platen.rhombic.force.kN, [920, 1150]);
  assert.deepStrictEqual(r.platen.rhombic.force.t, [94, 117]);
  assert.strictEqual(r.platen.rhombic.force.beams, 4);
  assert.deepStrictEqual(r.platen.rectangular.force.kN, [1150, 1438]);
  assert.strictEqual(r.cure.thickness, 12.5);
  assert.strictEqual(r.cure.soakUsed, 40);
  assert.deepStrictEqual(r.cure.total, [90, 110]);
});

test('soak time follows the standard table for other thicknesses', () => {
  const soak = (top, bottom) => L.jointCalc({ belt: 'EP 800/4', width: 1000, top, bottom }).cure.soakUsed;
  assert.strictEqual(soak(3.5, 2), 32); // 10 mm
  assert.strictEqual(soak(5, 2), 37);   // 11.5 mm: standard says 36 - 38
  assert.strictEqual(soak(6, 3.5), 45); // 14 mm: standard says 44 - 45
  assert.strictEqual(L.jointCalc({ belt: 'EP 800/4', width: 1000, top: 6, bottom: 2 }).cure.carcass, 4.5, 'carcass estimated from plies');
});

test('step length bands, gaps and the rule of thumb', () => {
  assert.strictEqual(L.stepFor(125).step, 200);
  assert.strictEqual(L.stepFor(250).step, 300);
  assert.strictEqual(L.stepFor(315).step, 350);
  assert.strictEqual(L.stepFor(280).step, 330);  // inside 250 - 315: interpolated, rounded up
  assert.strictEqual(L.stepFor(320).step, 400);  // between bands: next higher band
  assert.match(L.stepFor(320).notes[0], /between two bands/);
  assert.strictEqual(L.stepFor(800).step, 500, 'above the table: never shorter than EP 630');
  assert.strictEqual(L.stepFor(2400).step, 600, 'rule of thumb: 0.25 x 2400');
  assert.match(L.stepFor(800).notes[0], /above the standard table/);
});

test('steel cord belts get the splice band, not the fabric formula', () => {
  const r = L.jointCalc({ belt: 'ST 1000', width: 2000 });
  assert.strictEqual(r.kind, 'steel');
  assert.deepStrictEqual(r.band.splice, [800, 1300]);
  assert.strictEqual(L.jointCalc({ belt: 'ST2250', width: 2000 }).band, null);
});

test('missing inputs give a clear message', () => {
  assert.throws(() => L.jointCalc({ belt: 'EP 800', width: 1000 }), /plies/);
  assert.throws(() => L.jointCalc({ belt: 'EP 800/4' }), /width/);
  assert.strictEqual(L.jointCalc({ belt: 'EP 800/4', width: 1000 }).cure, null);
});

test('cure simulation profile: 30 C start at 3 C/min gives a 39 min heat-up', () => {
  const r = L.jointCalc({ belt: 'EP 800/4', width: 1000, top: 6, bottom: 2 });
  const p = L.cureProfile(r.cure, { ambient: 30, rate: 3, pressure: 8, coolMin: 20 });
  assert.strictEqual(p.ramp, 39);
  assert.strictEqual(p.soak, 40);
  assert.strictEqual(p.total, 99);
  assert.ok(p.points.filter((x) => x.phase === 'Heat-up' && x.temp < 100).every((x) => x.bar === 2.5), 'seat pressure below 100 C');
  assert.ok(p.points.filter((x) => x.phase === 'Soak' || x.phase === 'Cool-down').every((x) => x.bar === 8), 'full pressure until release');
  assert.ok(p.points.every((x) => x.temp <= 150));
  assert.strictEqual(p.points[p.points.length - 1].bar, 0);
});
