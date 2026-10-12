// Consumables: stock, expiry, consumption, file upload, and the request -> ticket -> issue flow.
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

function app() {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  ctx.updateWhere('Settings', 'Key', 'CompanyInbox', { Value: 'rtg@company.com' });
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const ok = (action, data, token) => {
    const r = call(action, data, token);
    assert.ok(r.ok, action + ': ' + r.error);
    return r.data;
  };
  const admin = ok('login', { userId: 'admin', password: temp }).token;
  const pw = ok('saveUser', { UserID: 'fm01', Name: 'FM One', Role: 'Local', Team: 'FM', Email: 'fm01@company.com' }, admin).tempPassword;
  const fm = ok('login', { userId: 'fm01', password: pw }).token;
  const notes = () => ctx.__mails.filter((m) => m.subject.startsWith('[RTG-NOTIFY]')).map((m) => JSON.parse(m.body));
  const item = (id) => ok('listConsumables', {}, admin).find((c) => c.ItemID === id);
  return { ctx, call, ok, admin, fm, notes, item };
}

test('stock summary: batches, expired stock, low stock', () => {
  const { ctx, ok, admin, item } = app();
  assert.strictEqual(ok('listConsumables', {}, admin).length, 14);
  const putty = item('C08'); // its only batch is past expiry
  assert.strictEqual(putty.stock, 3);
  assert.strictEqual(putty.expiredQty, ctx.today() > '2026-09-30' ? 3 : 0);
  ok('saveConsumable', { ItemID: 'C04', ReorderLevel: 20, Unit: 'kg', SAPStock: 15 }, admin);
  const c4 = item('C04');
  assert.strictEqual(c4.lowStock, true);
  assert.strictEqual(c4.Unit, 'kg');
  assert.strictEqual(String(c4.SAPStock), '15');
  assert.strictEqual(c4.SAPStockUpdatedOn, ctx.today());
});

test('receipt, issue first-expiring-first, adjustment and validation', () => {
  const { ctx, call, ok, admin, fm, item } = app();
  assert.match(call('stockEntry', { ItemID: 'C02', Type: 'Receipt', Qty: 5 }, fm).error, /permission/);
  ok('stockEntry', { ItemID: 'C02', Type: 'Receipt', Qty: 5, BatchNo: 'X1', ExpiryDate: '2099-12-31' }, admin);
  ok('stockEntry', { ItemID: 'C02', Type: 'Receipt', Qty: 4, BatchNo: 'X0', ExpiryDate: '2098-01-31' }, admin);
  assert.strictEqual(item('C02').stock, 9);
  assert.match(call('stockEntry', { ItemID: 'C02', Type: 'Issue', Qty: 3 }, admin).error, /Department is required/);
  assert.match(call('stockEntry', { ItemID: 'C02', Type: 'Issue', Qty: 30, Department: 'FM Sinter' }, admin).error, /Only 9/);
  // 6 = 4 from X0 (expires first) + 2 from X1.
  ok('stockEntry', { ItemID: 'C02', Type: 'Issue', Qty: 6, Department: 'FM Sinter' }, admin);
  const det = ok('consumableDetail', { ItemID: 'C02' }, admin);
  assert.deepStrictEqual(det.batches.map((b) => [b.BatchNo, b.Qty]), [['X1', 3]]);
  assert.deepStrictEqual(det.byDepartment, [{ department: 'FM Sinter', qty: 6 }]);
  assert.strictEqual(det.monthly.length, 12);
  assert.strictEqual(det.monthly[11].qty, 6);
  assert.strictEqual(det.summary.thisMonth, 6);
  assert.strictEqual(det.summary.avgMonthly, 1);
  ok('stockEntry', { ItemID: 'C02', Type: 'Adjustment', Qty: -1, BatchNo: 'X1' }, admin);
  assert.strictEqual(item('C02').stock, 2);
  assert.match(call('stockEntry', { ItemID: 'C02', Type: 'Adjustment', Qty: -5, BatchNo: 'X1' }, admin).error, /has only 2/);
  assert.match(call('stockEntry', { ItemID: 'C02', Type: 'Receipt', Qty: 1, Date: '2999-01-01' }, admin).error, /future/);
  // Expired stock is never issued.
  if (ctx.today() > '2026-09-30') assert.match(call('stockEntry', { ItemID: 'C08', Type: 'Issue', Qty: 1, Department: 'FM Sinter' }, admin).error, /not expired/);
});

test('file upload checks every row first and applies all or nothing', () => {
  const { ok, admin, item } = app();
  const rows = [
    { ItemName: 'TN 9000 Solution', Type: 'receipt', Qty: 10, BatchNo: 'U1', ExpiryDate: '2099-01-31' },
    { ItemName: 'Teapot', Type: 'Issue', Qty: 1 },
    { ItemName: 'tn 9000 solution', Type: 'Issue', Qty: 3, Department: 'FM Sinter', SAPStock: 40 }
  ];
  const before = item('C11').stock;
  const bad = ok('uploadStock', { rows }, admin);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.errors.map((e) => e.row), [2]);
  assert.strictEqual(item('C11').stock, before, 'nothing applied');
  const good = rows.filter((r) => r.ItemName !== 'Teapot');
  assert.strictEqual(ok('uploadStock', { rows: good, dryRun: true }, admin).ok, true);
  assert.strictEqual(item('C11').stock, before, 'dry run applies nothing');
  ok('uploadStock', { rows: good }, admin);
  assert.strictEqual(item('C11').stock, before + 7);
  assert.strictEqual(String(item('C11').SAPStock), '40');
});

test('consumable request: RTGC number, approve to CONS ticket, issue deducts stock', () => {
  const { call, ok, admin, fm, notes, item } = app();
  assert.match(call('raiseConsumableRequest', { ItemID: 'C01', Qty: 2, Department: 'FM Sinter' }, fm).error, /Purpose/);
  const { RequestNo } = ok('raiseConsumableRequest', { ItemID: 'C01', Qty: 3, Department: 'FM Sinter', Conveyor: 'SAMPLE CNV-205', Purpose: 'Hot joint on CNV-205' }, fm);
  assert.strictEqual(RequestNo, 'RTGC0001');
  assert.match(call('decideConsumableRequest', { RequestNo, decision: 'approve' }, fm).error, /permission/);
  assert.match(call('issueConsumable', { no: RequestNo }, admin).error, /pending/);
  const { TicketNo } = ok('decideConsumableRequest', { RequestNo, decision: 'approve' }, admin);
  assert.strictEqual(TicketNo, 'CONS_0001');
  assert.match(notes().find((n) => n.type === 'CONSUMABLE_APPROVED').to, /fm01@company.com/);
  const before = item('C01').stock;
  const res = ok('issueConsumable', { no: 'cons_0001' }, admin);
  // Sample batch A2 expires first, so it goes before A1.
  assert.deepStrictEqual(res.batches, ['SAMPLE-A2', 'SAMPLE-A1']);
  assert.strictEqual(item('C01').stock, before - 3);
  const req = ok('listConsumableRequests', {}, fm)[0];
  assert.strictEqual(req.Status, 'Issued');
  assert.strictEqual(req.ItemName, 'SAR Jointing Kit');
  assert.match(call('issueConsumable', { no: TicketNo }, admin).error, /issued/);
  // Reject needs a reason and mails it.
  const r2 = ok('raiseConsumableRequest', { ItemID: 'C04', Qty: 1, Department: 'FM Sinter', Purpose: 'Repair' }, fm).RequestNo;
  assert.match(call('decideConsumableRequest', { RequestNo: r2, decision: 'reject' }, admin).error, /reason/);
  ok('decideConsumableRequest', { RequestNo: r2, decision: 'reject', reason: 'Use the old stock first' }, admin);
  assert.match(notes().find((n) => n.type === 'CONSUMABLE_REJECTED').html, /old stock/);
  assert.strictEqual(ok('dashboard', {}, admin).consumablePending, 0);
});
