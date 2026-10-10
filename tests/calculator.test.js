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
  assert.strictEqual(r.platen.rhombic.length, 1000);
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
  const soak = (top, bottom) => L.jointCalc({ belt: 'EP 800/4', width: 1000, top, bottom, carcass: 4.5 }).cure.soakUsed;
  assert.strictEqual(L.jointCalc({ belt: 'EP 800/4', width: 1000, top: 3.5, bottom: 2, carcass: 4.5 }).cure.soakUsed, 32); // 10 mm
  assert.strictEqual(soak(5, 2), 37);  // 11.5 mm: standard says 36 - 38
  assert.strictEqual(soak(6, 3.5), 45); // 14 mm: standard says 44 - 45
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
