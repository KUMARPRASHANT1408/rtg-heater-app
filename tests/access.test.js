// What each team may see and do, and the heater request where FM gives only the belt details.
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

function app() {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  ctx.updateWhere('Settings', 'Key', 'CompanyInbox', { Value: 'rtg@company.com' });
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const ok = (action, data, token) => { const r = call(action, data, token); assert.ok(r.ok, action + ': ' + r.error); return r.data; };
  const admin = ok('login', { userId: 'admin', password: temp }).token;
  const user = (id, team, role) => {
    const pw = ok('saveUser', { UserID: id, Name: id.toUpperCase(), Role: role || 'Local', Team: team, Email: id + '@company.com' }, admin).tempPassword;
    return ok('login', { userId: id, password: pw }).token;
  };
  const t = { admin, fm: user('fm01', 'FM'), vendor: user('jv01', 'Vendor'), rtg: user('rtg01', 'RTG'), rv: user('rv01', 'RTG Vendor') };
  const notes = () => ctx.__mails.filter((m) => m.subject.startsWith('[RTG-NOTIFY]')).map((m) => JSON.parse(m.body));
  return { ctx, call, ok, t, notes };
}

const request = (extra) => Object.assign({
  ConveyorName: 'SAMPLE CNV-205', VendorTeam: 'ABC Belting', VendorSupervisor: 'R. Singh', VendorEmployeeID: 'V123', FMRepresentative: 'S. Das',
  FMEmail: 'sdas@company.com', IssueDate: '2026-10-10', ExpectedReturnDate: '2099-01-01', BeltWidth_mm: '1200', BeltRating_Nmm: '1250', Plies: '4'
}, extra);

test('only RTG and RTG Vendor see the stock; only RTG Vendor changes it', () => {
  const { call, t } = app();
  const can = (action, data, who) => call(action, data, t[who]).ok;
  const stockReads = [['heaterSearch', { width: 1200, rating: 1250 }], ['components', {}], ['listConsumables', {}], ['consumableDetail', { ItemID: 'C02' }]];
  stockReads.forEach(([a, d]) => {
    assert.ok(!can(a, d, 'fm') && !can(a, d, 'vendor'), a + ' is hidden from FM and vendors');
    assert.ok(can(a, d, 'rtg') && can(a, d, 'rv') && can(a, d, 'admin'), a + ' is open to the store');
  });
  const receipt = { ItemID: 'C02', Type: 'Receipt', Qty: 5, BatchNo: 'X1', ExpiryDate: '2099-12-31' };
  assert.match(call('stockEntry', receipt, t.rtg).error, /permission/);
  assert.match(call('stockEntry', receipt, t.fm).error, /permission/);
  assert.ok(can('stockEntry', receipt, 'rv'));
  assert.ok(can('saveConsumable', { ItemID: 'C02', ReorderLevel: '3' }, 'rv'));
  assert.match(call('saveConsumable', { ItemID: 'C02', ReorderLevel: '3' }, t.rtg).error, /permission/);
  const part = call('components', {}, t.rv).data.find((c) => c.Status === 'In store');
  assert.match(call('maintenance', { ComponentIDs: [part.ComponentID] }, t.rtg).error, /permission/);
  assert.ok(can('maintenance', { ComponentIDs: [part.ComponentID] }, 'rv'));
  // Admin pages stay admin-only.
  ['rtg', 'rv'].forEach((who) => {
    assert.match(call('listUsers', {}, t[who]).error, /permission/);
    assert.match(call('masterList', { tab: 'Settings' }, t[who]).error, /permission/);
  });
  // FM and vendors get no stock numbers on the home page either.
  const dash = call('dashboard', {}, t.vendor).data;
  assert.strictEqual(dash.consumableAlerts, 0);
  assert.strictEqual(dash.maintenanceDue, 0);
  assert.match(call('saveUser', { UserID: 'x1', Name: 'X', Role: 'Local', Team: 'Store' }, t.admin).error, /Unknown team/);
});

test('FM gives the belt details; the RTG team chooses the heater and issues it', () => {
  const { call, ok, t, notes } = app();
  assert.match(call('raiseRequest', request({ BeltWidth_mm: '' }), t.fm).error, /Belt width/);
  assert.match(call('raiseRequest', request({ BeltRating_Nmm: 'strong' }), t.fm).error, /rating/);
  const { RequestNo } = ok('raiseRequest', request({ HeaterAsked: 'HM-02' }), t.fm);
  assert.match(notes().pop().html, /HM-02 \(asked by FM\)/);
  const forFm = ok('getRequest', { no: RequestNo }, t.fm);
  assert.strictEqual(forFm.heaterOptions, undefined, 'FM does not see the store');
  assert.strictEqual(forFm.belt, '1200 mm · 1250 N/mm · 4 plies');
  const forRtg = ok('getRequest', { no: RequestNo }, t.rtg);
  const suitable = forRtg.heaterOptions.filter((o) => o.suitable);
  assert.ok(suitable.length && suitable[0].availableSets > 0);
  assert.ok(forRtg.heaterOptions.some((o) => !o.suitable), 'any heater can still be chosen');
  // Approving needs a heater; RTG Vendor and FM can't approve.
  assert.match(call('decideRequest', { RequestNo, decision: 'approve' }, t.rtg).error, /Choose the heater/);
  assert.match(call('decideRequest', { RequestNo, decision: 'approve', ModelID: 'HM-02' }, t.rv).error, /permission/);
  assert.match(call('decideRequest', { RequestNo, decision: 'approve', ModelID: 'HM-02' }, t.fm).error, /permission/);
  const { TicketNo } = ok('decideRequest', { RequestNo, decision: 'approve', ModelID: 'HM-02' }, t.rtg);
  const det = ok('getRequest', { no: TicketNo }, t.rv);
  assert.strictEqual(det.model.ModelID, 'HM-02');
  assert.strictEqual(det.request.RequestedComponents.reduce((a, c) => a + c.qty, 0), 11, 'a full set is asked for');
  assert.strictEqual(det.suggestion.short.length, 0);
  // RTG Vendor hands it over at the store; the rest of the flow is as before.
  ok('issueTicket', { TicketNo, items: det.suggestion.picks }, t.rv);
  ok('declareReturn', { TicketNo, ComponentIDs: det.suggestion.picks.map((p) => p.ComponentID) }, t.fm);
  const items = ok('getRequest', { no: TicketNo }, t.rtg).items.map((i) => ({ ComponentID: i.ComponentID, result: 'OK' }));
  assert.strictEqual(ok('returnTicket', { TicketNo, items }, t.rtg).status, 'Closed');
  assert.strictEqual(ok('listRequests', {}, t.fm)[0].ModelName, det.model.ModelName);
});

test('vendors ask for consumables by name and see only their own requests', () => {
  const { call, ok, t } = app();
  const names = ok('consumableItems', {}, t.vendor);
  assert.ok(names.length > 5);
  assert.deepStrictEqual(Object.keys(names[0]).sort(), ['ItemID', 'ItemName', 'Unit']);
  const { RequestNo } = ok('raiseConsumableRequest', { ItemID: names[0].ItemID, Qty: 2, Department: 'FM', Purpose: 'Joint on CNV-205' }, t.vendor);
  ok('raiseConsumableRequest', { ItemID: names[1].ItemID, Qty: 1, Department: 'FM', Purpose: 'Joint on CNV-101' }, t.fm);
  assert.deepStrictEqual(ok('listConsumableRequests', {}, t.vendor).map((r) => r.RequestNo), [RequestNo]);
  assert.strictEqual(ok('listConsumableRequests', {}, t.rtg).length, 2);
  assert.match(call('decideConsumableRequest', { RequestNo, decision: 'approve' }, t.vendor).error, /permission/);
  assert.match(call('decideConsumableRequest', { RequestNo, decision: 'approve' }, t.rv).error, /permission/);
  ok('decideConsumableRequest', { RequestNo, decision: 'approve' }, t.rtg);
  ok('stockEntry', { ItemID: names[0].ItemID, Type: 'Receipt', Qty: 5, BatchNo: 'B1', ExpiryDate: '2099-12-31' }, t.rv);
  assert.strictEqual(ok('issueConsumable', { no: RequestNo }, t.rv).status, 'Issued');
});

test('maintenance is logged by RTG Vendor and checked by the RTG team', () => {
  const { call, ok, t } = app();
  const file = { name: 'c.jpg', type: 'image/jpeg', data: Buffer.from('fake jpeg').toString('base64') };
  const part = ok('maintenanceDue', {}, t.rv)[0];
  assert.match(call('maintenanceDue', {}, t.vendor).error, /permission/);
  assert.match(call('logMaintenance', { ComponentIDs: [part.ComponentID], WorkDone: 'Cleaned', file }, t.vendor).error, /permission|maintenance vendor/);
  assert.match(call('logMaintenance', { ComponentIDs: [part.ComponentID], WorkDone: 'Cleaned', file }, t.rtg).error, /maintenance vendor/);
  const { LogNo } = ok('logMaintenance', { ComponentIDs: [part.ComponentID], WorkDone: 'Cleaned', file }, t.rv);
  assert.match(call('verifyMaintenance', { LogNo, decision: 'approve' }, t.rv).error, /permission/);
  ok('verifyMaintenance', { LogNo, decision: 'approve' }, t.rtg);
});
