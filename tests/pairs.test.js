// Pair heaters (like 14-CD) are built from two singles (14-C + 14-D) plus parts only the pair has.
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

function addRows(ctx, table, rows) { rows.forEach((r) => ctx.appendRow(table, r)); }

function app() {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const ok = (action, data, token) => {
    const r = call(action, data, token);
    assert.ok(r.ok, action + ': ' + r.error);
    return r.data;
  };
  const part = (model, name, id, qty) => ({ ComponentID: id, ModelID: model, SetNo: 1, ComponentName: name, Qty: qty || 1, Condition: 'OK', Status: 'In store', MaintenanceStatus: 'OK', JointsSinceMaintenance: 0 });
  addRows(ctx, 'HeaterModels', [
    { ModelID: '14-C', ModelName: 'Heater 14-C' }, { ModelID: '14-D', ModelName: 'Heater 14-D' },
    { ModelID: '14-CD', ModelName: 'Heater 14-CD', MadeFrom: '14-C, 14-D' }
  ]);
  addRows(ctx, 'ComponentTypes', [
    { ModelID: '14-C', ComponentName: 'Heating Platen', QtyPerSet: 2 }, { ModelID: '14-C', ComponentName: 'Cross Beam', QtyPerSet: 10 },
    { ModelID: '14-D', ComponentName: 'Heating Platen', QtyPerSet: 2 }, { ModelID: '14-D', ComponentName: 'Cross Beam', QtyPerSet: 10 },
    { ModelID: '14-CD', ComponentName: 'Heating Platen', QtyPerSet: 4 }, { ModelID: '14-CD', ComponentName: 'Cross Beam', QtyPerSet: 18 },
    { ModelID: '14-CD', ComponentName: 'Pressure Plate', QtyPerSet: 2 }
  ]);
  addRows(ctx, 'Components', [
    part('14-C', 'Heating Platen', '14-C-HP1'), part('14-C', 'Heating Platen', '14-C-HP2'), part('14-C', 'Cross Beam', '14-C-CB', 10),
    part('14-D', 'Heating Platen', '14-D-HP1'), part('14-D', 'Heating Platen', '14-D-HP2'), part('14-D', 'Cross Beam', '14-D-CB', 10),
    part('14-CD', 'Pressure Plate', '14-CD-PRP1'), part('14-CD', 'Pressure Plate', '14-CD-PRP2')
  ]);
  addRows(ctx, 'HeaterSelection', [
    { BeltWidth_mm: 1400, BeltRating: '800', Plies: 4, HeaterIDs: '14-C, 14-D' },
    { BeltWidth_mm: 1400, BeltRating: '1000', Plies: 5, HeaterIDs: '14-CD' },
    { BeltWidth_mm: 2000, BeltRating: 'ST1000', Plies: '', HeaterIDs: '14-CD' }
  ]);
  const admin = ok('login', { userId: 'admin', password: temp }).token;
  const fmPw = ok('saveUser', { UserID: 'fm01', Name: 'FM One', Role: 'Local', Team: 'FM', Email: 'fm01@company.com' }, admin).tempPassword;
  const fm = ok('login', { userId: 'fm01', password: fmPw }).token;
  const issue = (model, comps) => {
    const { RequestNo } = ok('raiseRequest', {
      ModelID: model, ConveyorName: 'CNV-1', VendorTeam: 'ABC', VendorSupervisor: 'R', VendorEmployeeID: 'V1', FMRepresentative: 'S', FMEmail: 's@company.com',
      IssueDate: '2026-10-10', ExpectedReturnDate: '2026-10-12', RequestedComponents: comps }, fm);
    const { TicketNo } = ok('decideRequest', { RequestNo, decision: 'approve' }, admin);
    const det = ok('getRequest', { no: TicketNo }, admin);
    assert.strictEqual(det.suggestion.short.length, 0, JSON.stringify(det.suggestion.short));
    ok('issueTicket', { TicketNo, items: det.suggestion.picks.map((p) => ({ ComponentID: p.ComponentID, Qty: p.Qty })) }, admin);
    return TicketNo;
  };
  const stats = (w, r, p) => {
    const res = ok('heaterSearch', { width: w, rating: r, plies: p }, fm);
    const by = {};
    res.suitable.forEach((s) => { by[s.model.ModelID] = s; });
    return { res, by };
  };
  return { ctx, ok, call, admin, fm, issue, stats };
}

const PAIR = [{ name: 'Heating Platen', qty: 4 }, { name: 'Cross Beam', qty: 18 }, { name: 'Pressure Plate', qty: 2 }];

test('a pair is ready only when both singles are in store, and totals count singles only', () => {
  const { issue, stats } = app();
  let { res, by } = stats(1400, 1000, 5);
  assert.strictEqual(by['14-CD'].availableSets, 1);
  assert.deepStrictEqual(by['14-CD'].madeFrom, ['14-C', '14-D']);
  assert.strictEqual(res.totals.heatersInStore, 2, 'the pair is not a third heater');

  const tk = issue('14-C', [{ name: 'Heating Platen', qty: 2 }, { name: 'Cross Beam', qty: 10 }]);
  ({ by } = stats(1400, 1000, 5));
  assert.strictEqual(by['14-CD'].availableSets, 0);
  assert.strictEqual(by['14-CD'].deployedCount, 0);
  assert.deepStrictEqual(by['14-CD'].blockedBy.map((b) => [b.ticket, b.via]), [[tk, '14-C']]);
  // The other single still shows, but only for the low-rating belt the guide lists it for.
  ({ by } = stats(1400, 800, 4));
  assert.strictEqual(by['14-D'].availableSets, 1);
  assert.strictEqual(by['14-C'].deployedCount, 1);
});

test('issuing a pair takes both singles parts; the singles then show as out with the pair', () => {
  const { ctx, issue, stats } = app();
  const tk = issue('14-CD', PAIR);
  const items = ctx.readTable('TicketItems').filter((i) => i.TicketNo === tk);
  const models = new Set(items.map((i) => ctx.readTable('Components').find((c) => c.ComponentID === i.ComponentID).ModelID));
  assert.deepStrictEqual([...models].sort(), ['14-C', '14-CD', '14-D']);
  assert.strictEqual(items.reduce((a, i) => a + Number(i.QtyOut), 0), 4 + 18 + 2);
  let { by } = stats(1400, 1000, 5);
  assert.strictEqual(by['14-CD'].deployedCount, 1);
  assert.strictEqual(by['14-CD'].blockedBy.length, 0);
  ({ by } = stats(1400, 800, 4));
  assert.strictEqual(by['14-C'].availableSets, 0);
  assert.strictEqual(by['14-D'].deployments[0].via, '14-CD');
});

test('steel-cord ratings: ST1000 matches the ST row; the typed text is kept', () => {
  const { stats } = app();
  const { res, by } = stats(2000, 'st 1000');
  assert.ok(by['14-CD']);
  assert.strictEqual(res.query.rating, 'ST1000');
  assert.strictEqual(stats(1400, 'ST1000', 5).res.suitable.length, 0, 'ST only matches steel-cord rows');
  assert.ok(stats(1400, '1000', 5).by['14-CD'], 'a plain number still matches fabric rows');
});

test('issue refuses a part from a heater the ticket is not built from', () => {
  const { ctx, ok, call, admin, fm } = app();
  addRows(ctx, 'HeaterModels', [{ ModelID: '8-A', ModelName: 'Heater 8-A' }]);
  addRows(ctx, 'ComponentTypes', [{ ModelID: '8-A', ComponentName: 'Heating Platen', QtyPerSet: 2 }]);
  addRows(ctx, 'Components', [{ ComponentID: '8-A-HP1', ModelID: '8-A', SetNo: 1, ComponentName: 'Heating Platen', Qty: 1, Condition: 'OK', Status: 'In store', MaintenanceStatus: 'OK' }]);
  const { RequestNo } = ok('raiseRequest', {
    ModelID: '14-CD', ConveyorName: 'CNV-1', VendorTeam: 'ABC', VendorSupervisor: 'R', VendorEmployeeID: 'V1', FMRepresentative: 'S', FMEmail: 's@company.com',
    IssueDate: '2026-10-10', ExpectedReturnDate: '2026-10-12', RequestedComponents: PAIR }, fm);
  const { TicketNo } = ok('decideRequest', { RequestNo, decision: 'approve' }, admin);
  assert.match(call('issueTicket', { TicketNo, items: [{ ComponentID: '8-A-HP1', Qty: 1 }] }, admin).error, /different heater/);
});

test('maintenance list marks the parts only a pair has', () => {
  const { ok, admin } = app();
  const rows = ok('maintenanceDue', {}, admin);
  assert.deepStrictEqual([...new Set(rows.filter((r) => r.PairOf).map((r) => r.ModelID + '=' + r.PairOf))], ['14-CD=14-C + 14-D']);
  assert.ok(rows.filter((r) => r.ModelID === '14-C').every((r) => r.PairOf === ''));
});

test('clearTestData puts split lots back and resets every part', () => {
  const { ctx, issue } = app();
  const before = ctx.readTable('Components').length;
  issue('14-CD', PAIR);
  assert.ok(ctx.readTable('Components').some((c) => c.ComponentID.startsWith('14-D-CB/')), 'the issue split the beam lot');
  ctx.updateWhere('Components', 'ComponentID', '14-C-HP1', { Condition: 'Damaged', LastInspected: '2026-10-10' });
  ctx.clearTestData();
  const after = ctx.readTable('Components');
  assert.strictEqual(after.length, before);
  assert.strictEqual(Number(after.find((c) => c.ComponentID === '14-D-CB').Qty), 10);
  assert.ok(after.every((c) => c.Status === 'In store' && c.Condition === 'OK' && !c.LastInspected && !c.CurrentTicket));
});
