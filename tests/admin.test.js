// Settings, conveyor and department lists, and the activity log, edited from the app instead of the Sheet.
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
  const fmPw = ok('saveUser', { UserID: 'fm01', Name: 'FM', Role: 'Local', Team: 'FM' }, admin).tempPassword;
  const fm = ok('login', { userId: 'fm01', password: fmPw }).token;
  return { ctx, call, ok, admin, fm };
}

test('settings: admins change values; keys are fixed; the Drive folder setting stays hidden', () => {
  const { ctx, call, ok, admin, fm } = app();
  assert.match(call('masterList', { tab: 'Settings' }, fm).error, /permission/);
  const list = ok('masterList', { tab: 'Settings' }, admin);
  assert.ok(list.rows.some((r) => r.Key === 'CompanyInbox'));
  assert.ok(!list.rows.some((r) => r.Key === 'ChecklistFolderId'));
  ok('masterSave', { tab: 'Settings', rows: [{ Key: 'CompanyInbox', Value: ' rtg@company.com ', Notes: 'hacked' }] }, admin);
  const row = ctx.readTable('Settings').find((r) => r.Key === 'CompanyInbox');
  assert.strictEqual(row.Value, 'rtg@company.com');
  assert.notStrictEqual(row.Notes, 'hacked', 'only Value can change');
  assert.match(call('masterSave', { tab: 'Settings', rows: [{ Key: 'NewThing', Value: 'x' }] }, admin).error, /not a setting/);
  assert.match(call('masterDelete', { tab: 'Settings', key: 'CompanyInbox' }, admin).error, /cannot be deleted/);
  assert.match(call('masterSave', { tab: 'Users', rows: [{ UserID: 'x' }] }, admin).error, /cannot be edited/);
});

test('conveyors: add, bulk upload with updates, rename, delete; lookups follow', () => {
  const { ctx, call, ok, admin, fm } = app();
  ok('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: 'CNV-900', Area: 'Coke', BeltWidth_mm: '1400', BeltRating_Nmm: '1600', Plies: '4' }] }, admin);
  assert.strictEqual(ctx.readTable('Conveyors').find((c) => c.ConveyorName === 'CNV-900').BeltWidth_mm, 1400);
  const res = ok('masterSave', { tab: 'Conveyors', rows: [
    { ConveyorName: 'cnv-900', Area: 'Coke plant' }, { ConveyorName: 'CNV-901', BeltWidth_mm: '1000' }] }, admin);
  assert.deepStrictEqual(res, { added: 1, updated: 1 });
  assert.strictEqual(ctx.readTable('Conveyors').find((c) => c.ConveyorName === 'cnv-900').Area, 'Coke plant');
  assert.match(call('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: 'A', BeltWidth_mm: 'wide' }, { ConveyorName: 'a' }] }, admin).error, /must be a number.*appears twice/);
  assert.match(call('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: '' }] }, admin).error, /ConveyorName is required/);
  ok('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: 'CNV-902', Area: 'Coke plant' }], originalKey: 'cnv-900' }, admin);
  assert.match(call('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: 'CNV-901' }], originalKey: 'CNV-902' }, admin).error, /already exists/);
  ok('masterDelete', { tab: 'Conveyors', key: 'CNV-901' }, admin);
  const names = ok('lookups', {}, fm).conveyors.map((c) => c.ConveyorName);
  assert.ok(names.includes('CNV-902') && !names.includes('CNV-901') && !names.includes('cnv-900'));
  ok('masterSave', { tab: 'Departments', rows: [{ Department: 'Sinter' }] }, admin);
  assert.ok(ok('lookups', {}, fm).departments.includes('Sinter'));
});

test('activity and mail logs, newest first, admins only', () => {
  const { call, ok, admin, fm } = app();
  ok('masterSave', { tab: 'Departments', rows: [{ Department: 'Coke' }] }, admin);
  assert.match(call('adminLog', { log: 'AuditLog' }, fm).error, /permission/);
  const log = ok('adminLog', { log: 'AuditLog' }, admin);
  assert.deepStrictEqual(log.columns, ['Time', 'UserID', 'Action', 'Ref', 'Details']);
  assert.strictEqual(log.rows[0].Action, 'saveList');
  assert.strictEqual(log.rows[0].Ref, 'Departments');
  assert.strictEqual(ok('adminLog', { log: 'MailOutbox' }, admin).log, 'MailOutbox');
});
