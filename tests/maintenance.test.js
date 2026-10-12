// RTG maintenance log with checklist -> RTG verifies -> parts ready to issue again.
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

test('RTG logs maintenance with a checklist; RTG verifies or rejects', () => {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  ctx.updateWhere('Settings', 'Key', 'CompanyInbox', { Value: 'rtg@company.com' });
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const ok = (action, data, token) => { const r = call(action, data, token); assert.ok(r.ok, action + ': ' + r.error); return r.data; };
  const admin = ok('login', { userId: 'admin', password: temp }).token;
  const vpw = ok('saveUser', { UserID: 'vm1', Name: 'Vendor Maint', Role: 'Local', Team: 'RTG', Email: 'vm1@x.com' }, admin).tempPassword;
  const vendor = ok('login', { userId: 'vm1', password: vpw }).token;
  const fpw = ok('saveUser', { UserID: 'fm1', Name: 'FM', Role: 'Local', Team: 'FM' }, admin).tempPassword;
  const fm = ok('login', { userId: 'fm1', password: fpw }).token;

  // Two parts of HM-02 set 1 come back needing maintenance; the HM-01 bag is damaged too.
  ['HM-02-S1-TP', 'HM-02-S1-BP', 'HM-01-S3-PB'].forEach((id) => ctx.updateWhere('Components', 'ComponentID', id, { MaintenanceStatus: 'Due' }));
  assert.strictEqual(ok('heaterSearch', { width: 1200, rating: 1250 }, admin).totals.suitableAvailable, 3);
  assert.match(call('maintenanceDue', {}, fm).error, /permission/);
  const listed = ok('maintenanceDue', {}, vendor);
  assert.deepStrictEqual(listed.filter((c) => c.due).map((c) => c.ComponentID).sort(), ['HM-01-S3-PB', 'HM-02-S1-BP', 'HM-02-S1-TP']);
  assert.ok(listed.length > 3, 'every heater in store is listed for routine maintenance');

  const file = { name: 'c.jpg', type: 'image/jpeg', data: Buffer.from('fake jpeg').toString('base64') };
  const base = { ComponentIDs: ['HM-02-S1-TP', 'HM-02-S1-BP'], WorkDone: 'Cleaned platens, checked wiring', file };
  assert.match(call('logMaintenance', base, fm).error, /permission/);
  assert.match(call('logMaintenance', Object.assign({}, base, { file: null }), vendor).error, /checklist/);
  assert.match(call('logMaintenance', Object.assign({}, base, { file: { type: 'text/plain', data: 'eA==' } }), vendor).error, /photo/);
  assert.match(call('logMaintenance', Object.assign({}, base, { ComponentIDs: ['NOPE-1'] }), vendor).error, /not in the store/);
  const { LogNo } = ok('logMaintenance', base, vendor);
  assert.strictEqual(LogNo, 'MNT0001');
  assert.match(call('logMaintenance', base, vendor).error, /already in log MNT0001/);
  const mail = ctx.__mails.find((m) => m.subject === '[RTG-NOTIFY] MAINTENANCE_LOGGED MNT0001');
  assert.ok(mail);
  // Checklist comes back as uploaded.
  const cl = ok('getChecklist', { LogNo }, admin);
  assert.strictEqual(Buffer.from(cl.data, 'base64').toString(), 'fake jpeg');
  assert.strictEqual(ok('dashboard', {}, admin).maintenanceToVerify, 1);
  // Not ready until RTG verifies.
  assert.strictEqual(ok('heaterSearch', { width: 1200, rating: 1250 }, admin).totals.suitableAvailable, 3);
  assert.match(call('verifyMaintenance', { LogNo, decision: 'approve' }, fm).error, /permission/);
  ok('verifyMaintenance', { LogNo, decision: 'approve' }, admin);
  assert.strictEqual(ok('heaterSearch', { width: 1200, rating: 1250 }, admin).totals.suitableAvailable, 4);
  assert.strictEqual(ok('listMaintenanceLogs', {}, vendor)[0].Status, 'Verified');

  // Damaged bag: repaired during maintenance, but RTG rejects the first log.
  const bag = { ComponentIDs: ['HM-01-S3-PB'], RepairedIDs: ['HM-01-S3-PB'], WorkDone: 'Patched the bag', file };
  const n2 = ok('logMaintenance', bag, vendor).LogNo;
  assert.match(call('verifyMaintenance', { LogNo: n2, decision: 'reject' }, admin).error, /what is wrong/);
  ok('verifyMaintenance', { LogNo: n2, decision: 'reject', remark: 'Patch is leaking' }, admin);
  assert.ok(ctx.__mails.some((m) => m.subject.includes('MAINTENANCE_REJECTED')));
  const n3 = ok('logMaintenance', bag, vendor).LogNo;
  ok('verifyMaintenance', { LogNo: n3, decision: 'approve' }, admin);
  const pb = ok('components', {}, admin).find((c) => c.ComponentID === 'HM-01-S3-PB');
  assert.deepStrictEqual([pb.Condition, pb.MaintenanceStatus], ['OK', 'OK']);
  // Routine maintenance on a heater that wasn't due just records the date.
  const n4 = ok('logMaintenance', { ComponentIDs: ['HM-03-S1-TP'], WorkDone: 'Monthly check', file }, vendor).LogNo;
  ok('verifyMaintenance', { LogNo: n4, decision: 'approve' }, admin);
  assert.strictEqual(ok('components', {}, admin).find((c) => c.ComponentID === 'HM-03-S1-TP').LastInspected, ctx.today());
});

test('clearTestData removes test activity but keeps master data and users', () => {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const admin = call('login', { userId: 'admin', password: temp }).data.token;
  call('raiseConsumableRequest', { ItemID: 'C01', Qty: 1, Department: 'FM', Purpose: 'test' }, admin);
  ctx.updateWhere('Components', 'ComponentID', 'HM-01-S1-TP', { Status: 'Issued', CurrentTicket: 'HEATER_0001' });
  const comps = ctx.readTable('Components').length;
  ctx.clearTestData();
  assert.strictEqual(ctx.readTable('ConsumableRequests').length, 0);
  assert.strictEqual(ctx.readTable('ConsumableTransactions').length, 0);
  assert.strictEqual(ctx.readTable('ConsumableBatches').length, 0);
  assert.strictEqual(ctx.readTable('Components').length, comps);
  assert.strictEqual(ctx.readTable('Components').find((c) => c.ComponentID === 'HM-01-S1-TP').Status, 'In store');
  assert.strictEqual(ctx.readTable('Users').length, 1);
  assert.strictEqual(ctx.nextNumber('crequest', 'RTGC'), 'RTGC0001');
});

test('maintenance can say what was done on each part; a new setting shows up before setup adds it', () => {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  const ok = (action, data, token) => { const r = call(action, data, token); assert.ok(r.ok, action + ': ' + r.error); return r.data; };
  const admin = ok('login', { userId: 'admin', password: temp }).token;
  const file = { name: 'c.jpg', type: 'image/jpeg', data: Buffer.from('x').toString('base64') };
  const ids = ['HM-02-S1-TP', 'HM-02-S1-BP'];
  assert.match(call('logMaintenance', { ComponentIDs: ids, PartWork: { 'HM-02-S1-TP': 'Cleaned' }, file }, admin).error, /each part/);
  ok('logMaintenance', { ComponentIDs: ids, PartWork: { 'HM-02-S1-TP': 'Cleaned platen', 'HM-02-S1-BP': 'Changed 2 bolts' }, file }, admin);
  const log = ok('listMaintenanceLogs', {}, admin)[0];
  assert.deepStrictEqual(log.parts.map((p) => p.work), ['Cleaned platen', 'Changed 2 bolts']);

  // An older database without the new row: the setting is still listed, and saving it adds the row.
  ctx.updateWhere('Settings', 'Key', 'FMHODMail', { Key: 'OldUnusedKey' });
  assert.ok(ok('masterList', { tab: 'Settings' }, admin).rows.some((r) => r.Key === 'FMHODMail'));
  ok('masterSave', { tab: 'Settings', rows: [{ Key: 'FMHODMail', Value: 'fmhod@x.com' }] }, admin);
  assert.strictEqual(ctx.readTable('Settings').find((r) => r.Key === 'FMHODMail').Value, 'fmhod@x.com');
  assert.match(call('masterSave', { tab: 'Settings', rows: [{ Key: 'Nope', Value: '1' }] }, admin).error, /not a setting/);
});
