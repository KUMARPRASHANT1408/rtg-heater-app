// Steel-cord belts (ST ratings, no plies), the ST1600 / ST-1600 distinction, and the admin heater list and guide.
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

function app() {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const ok = (action, data, token) => { const r = call(action, data, token); assert.ok(r.ok, action + ': ' + r.error); return r.data; };
  const admin = ok('login', { userId: 'admin', password: temp }).token;
  const pw = ok('saveUser', { UserID: 'fm01', Name: 'FM', Role: 'Local', Team: 'FM', Email: 'fm@x.com' }, admin).tempPassword;
  const fm = ok('login', { userId: 'fm01', password: pw }).token;
  return { ctx, call, ok, admin, fm };
}

const PARTS_12CD = [['Heating Platen', 4], ['Cross Beam', 22], ['Pressure Plate', 2], ['End Bolt & Nut', 22], ['Edge Bar', 2], ['Edge Clamp', 2],
  ['Control Panel', 2], ['Incoming Cable', 2], ['Outgoing Cable', 4], ['Distributor Block with Water Pressure Hose', 2],
  ['Distributor Block with Water Cooling Hose (Input)', 2], ['Water Pressure Bag', 2], ['Pressure Ply (Wooden)', 2], ['Water Pump Unit', 1],
  ['63A DS-6 Plug', 3], ['125A DS-9 Plug', 1], ['JB Box', 1]].map(([name, qty]) => ({ name, qty }));

test('admin adds a heater with one full set of parts', () => {
  const { call, ok, admin, fm } = app();
  assert.match(call('addHeater', { ModelID: '12CD', parts: PARTS_12CD }, fm).error, /permission/);
  const r = ok('addHeater', { ModelID: '12cd', parts: PARTS_12CD }, admin);
  assert.deepStrictEqual(r, { ModelID: '12-CD', parts: 34 });
  assert.match(call('addHeater', { ModelID: '12-CD', parts: PARTS_12CD }, admin).error, /already exists/);
  const parts = ok('components', {}, admin).filter((c) => c.ModelID === '12-CD');
  const ids = parts.map((c) => c.ComponentID);
  ['12-CD-HP1', '12-CD-HP4', '12-CD-CB', '12-CD-BN', '12-CD-P631', '12-CD-P633', '12-CD-WPU', '12-CD-JB'].forEach((id) => assert.ok(ids.includes(id), id));
  assert.strictEqual(parts.find((c) => c.ComponentID === '12-CD-CB').Qty, 22);
  const h = ok('listHeaters', {}, admin).heaters.find((x) => x.ModelID === '12-CD');
  assert.strictEqual(h.ModelName, 'Heater 12-CD');
  assert.strictEqual(h.parts.length, 17);
});

test('the guide keeps ST1600 and ST-1600 apart and a plain number means a fabric belt', () => {
  const { call, ok, admin, fm } = app();
  ok('addHeater', { ModelID: '12-CD', parts: PARTS_12CD }, admin);
  // The RTG guide's own layout: rating and plies together, heater numbers without a hyphen.
  const rows = [
    { BeltWidth_mm: '1400', BeltRating: '1000/5', HeaterIDs: 'HM-02, HM-03' },
    { BeltWidth_mm: '1400', BeltRating: 'ST1600', HeaterIDs: 'HM-02, HM-03' },
    { BeltWidth_mm: '1400', BeltRating: 'ST-1600', HeaterIDs: 'HM-02' },
    { BeltWidth_mm: '1200', BeltRating: 'st 2000', HeaterIDs: '12CD' }
  ];
  assert.match(call('saveHeaterGuide', { rows: rows.concat([{ BeltWidth_mm: '1200', BeltRating: '800/4', HeaterIDs: '99Z' }]) }, admin).error, /99-Z is not in the heater list/);
  assert.match(call('saveHeaterGuide', { rows: rows.concat([rows[1]]) }, admin).error, /appears twice/);
  assert.match(call('saveHeaterGuide', { rows: [{ BeltWidth_mm: '1400', BeltRating: 'strong', HeaterIDs: 'HM-02' }] }, admin).error, /rating "strong"/);
  assert.strictEqual(ok('saveHeaterGuide', { rows }, admin).rows, 4);
  const guide = ok('heaterGuide', {}, admin).rows;
  assert.deepStrictEqual(guide.map((g) => [g.BeltRating, g.Plies, g.HeaterIDs]),
    [['1000', 5, 'HM-02, HM-03'], ['ST1600', '', 'HM-02, HM-03'], ['ST-1600', '', 'HM-02'], ['ST2000', '', '12-CD']]);
  // Uploading again replaces the guide, it does not add to it.
  assert.strictEqual(ok('saveHeaterGuide', { rows }, admin).rows, 4);
  assert.strictEqual(ok('heaterGuide', {}, admin).rows.length, 4);
  const ids = (rating, plies) => ok('heaterSearch', { width: 1400, rating, plies }, admin).suitable.map((s) => s.model.ModelID).sort();
  assert.deepStrictEqual(ids('ST1600'), ['HM-02', 'HM-03']);
  assert.deepStrictEqual(ids('ST-1600'), ['HM-02']);
  assert.deepStrictEqual(ids('1000', 5), ['HM-02', 'HM-03']);
  assert.deepStrictEqual(ids('1600'), [], 'a fabric 1600 is not the steel-cord row');
  assert.deepStrictEqual(ok('heaterSearch', { width: 1200, rating: 'ST2000' }, admin).suitable.map((s) => s.model.ModelID), ['12-CD']);
  assert.match(call('heaterGuide', {}, fm).error, /permission/);
});

test('conveyors and requests take steel-cord ratings without plies', () => {
  const { call, ok, admin, fm } = app();
  const res = ok('masterSave', { tab: 'Conveyors', rows: [
    { ConveyorName: '02FW01A', BeltWidth_mm: '1400', BeltRating_Nmm: 'st-1600', Plies: '4' },
    { ConveyorName: '02FW02', BeltWidth_mm: '1400', BeltRating_Nmm: 'ST1600' },
    { ConveyorName: 'CNV-9', BeltWidth_mm: '1200', BeltRating_Nmm: '1000', Plies: '4' }] }, admin);
  assert.strictEqual(res.added, 3);
  const conv = ok('lookups', {}, admin).conveyors;
  const a = conv.find((c) => c.ConveyorName === '02FW01A');
  assert.strictEqual(a.BeltRating_Nmm, 'ST-1600');
  assert.strictEqual(a.Plies, '', 'a steel-cord belt has no plies');
  assert.strictEqual(conv.find((c) => c.ConveyorName === 'CNV-9').BeltRating_Nmm, 1000);
  assert.match(call('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: 'X', BeltWidth_mm: '1400', BeltRating_Nmm: '1000/4' }] }, admin).error, /Belt rating "1000\/4"/);
  const req = { ConveyorName: '02FW01A', VendorTeam: 'ABC', VendorSupervisor: 'R', VendorEmployeeID: 'V1', FMRepresentative: 'S', IssueDate: '2026-10-12',
    ExpectedReturnDate: '2099-01-01', BeltWidth_mm: '1400', BeltRating_Nmm: 'ST-1600', Plies: '4' };
  const { RequestNo } = ok('raiseRequest', req, fm);
  const r = ok('getRequest', { no: RequestNo }, fm);
  assert.strictEqual(r.request.BeltRating_Nmm, 'ST-1600');
  assert.strictEqual(r.belt, '1400 mm · ST-1600 N/mm');
  assert.match(call('raiseRequest', Object.assign({}, req, { BeltRating_Nmm: 'ST/1600' }), fm).error, /belt rating/);
});
