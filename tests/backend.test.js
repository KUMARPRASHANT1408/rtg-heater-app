// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

function freshApp() {
  const ctx = makeContext();
  const msg = ctx.setup();
  const temp = /temporary password: (\S+)/.exec(msg)[1];
  ctx.loadSampleData();
  // JSON round-trip, as over the wire.
  const call = (action, data, token) => JSON.parse(JSON.stringify(ctx.handle({ action, data, token })));
  return { ctx, temp, call };
}

test('setup creates every tab and is safe to re-run', () => {
  const { ctx } = freshApp();
  const names = Object.keys(ctx.SCHEMA);
  names.forEach((n) => assert.ok(ctx.__sheets[n], n));
  const usersBefore = ctx.readTable('Users').length;
  const settingsBefore = ctx.readTable('Settings').length;
  ctx.setup();
  assert.strictEqual(ctx.readTable('Users').length, usersBefore);
  assert.strictEqual(ctx.readTable('Settings').length, settingsBefore);
});

test('login, wrong password, forced password change', () => {
  const { temp, call } = freshApp();
  assert.strictEqual(call('login', { userId: 'admin', password: 'nope' }).ok, false);
  const r = call('login', { userId: 'ADMIN', password: temp });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.user.MustChangePassword, true);
  assert.strictEqual(r.data.user.PasswordHash, undefined, 'hash must never leave the server');
  const t = r.data.token;
  assert.strictEqual(call('changePassword', { oldPassword: temp, newPassword: 'short' }, t).ok, false);
  assert.ok(call('changePassword', { oldPassword: temp, newPassword: 'NewPass123' }, t).ok);
  assert.strictEqual(call('me', {}, t).data.user.MustChangePassword, false);
  assert.ok(call('login', { userId: 'admin', password: 'NewPass123' }).ok);
});

test('locks out after 5 failed logins', () => {
  const { temp, call } = freshApp();
  for (let i = 0; i < 5; i++) call('login', { userId: 'admin', password: 'x' });
  const r = call('login', { userId: 'admin', password: temp });
  assert.match(r.error, /Too many/);
});

test('roles: local user cannot manage users, admin can', () => {
  const { temp, call } = freshApp();
  const admin = call('login', { userId: 'admin', password: temp }).data.token;
  const created = call('saveUser', { UserID: 'fm01', Name: 'FM Person', Role: 'Local', Team: 'FM' }, admin);
  assert.ok(created.ok, created.error);
  const local = call('login', { userId: 'fm01', password: created.data.tempPassword }).data.token;
  assert.match(call('listUsers', {}, local).error, /permission/);
  // FM asks for heaters but does not see the store's stock.
  assert.match(call('heaterSearch', { width: 1200, rating: 1250, plies: 4 }, local).error, /permission/);
  assert.ok(call('heaterSearch', { width: 1200, rating: 1250, plies: 4 }, admin).ok);
  assert.strictEqual(call('listUsers', {}, admin).data.length, 2);
  // Promote, then disable.
  assert.ok(call('saveUser', { UserID: 'fm01', Name: 'FM Person', Role: 'Admin', Team: 'FM' }, admin).ok);
  assert.ok(call('listUsers', {}, local).ok);
  call('saveUser', { UserID: 'fm01', Name: 'FM Person', Role: 'Local', Active: false }, admin);
  assert.strictEqual(call('me', {}, local).auth, true);
  // Admin can't demote themself.
  assert.match(call('saveUser', { UserID: 'admin', Name: 'x', Role: 'Local' }, admin).error, /own admin/);
});

test('admin can delete another user, not themself', () => {
  const { temp, call } = freshApp();
  const admin = call('login', { userId: 'admin', password: temp }).data.token;
  const pw = call('saveUser', { UserID: 'fm01', Name: 'FM Person', Role: 'Local', Team: 'FM' }, admin).data.tempPassword;
  call('saveUser', { UserID: 'fm02', Name: 'Second', Role: 'Local', Team: 'FM' }, admin);
  const local = call('login', { userId: 'fm01', password: pw }).data.token;
  assert.match(call('deleteUser', { UserID: 'fm02' }, local).error, /permission/);
  assert.match(call('deleteUser', { UserID: 'admin' }, admin).error, /own account/);
  assert.ok(call('deleteUser', { UserID: 'fm01' }, admin).ok);
  assert.deepStrictEqual(call('listUsers', {}, admin).data.map(u => u.UserID).sort(), ['admin', 'fm02']);
  assert.strictEqual(call('me', {}, local).auth, true); // their open session ends
  assert.ok(!call('login', { userId: 'fm01', password: pw }).ok);
  assert.match(call('deleteUser', { UserID: 'fm01' }, admin).error, /No such user/);
});

test('no token or unknown action is rejected', () => {
  const { call } = freshApp();
  assert.strictEqual(call('heaterSearch', { width: 1000 }).auth, true);
  assert.match(call('dropTables', {}, 'x').error, /Unknown action/);
});

test('heater search: suitability, availability and deployments from sample data', () => {
  const { temp, call } = freshApp();
  const t = call('login', { userId: 'admin', password: temp }).data.token;
  const r = call('heaterSearch', { width: 1200, rating: 1250, plies: 4 }, t).data;
  assert.deepStrictEqual(r.suitable.map((s) => s.model.ModelID), ['HM-02']);
  // HM-02 has 4 sets, all in store.
  assert.strictEqual(r.totals.suitableTotal, 4);
  assert.strictEqual(r.totals.suitableAvailable, 4);
  assert.strictEqual(r.totals.suitableDeployed, 0);
  assert.deepStrictEqual(r.deployments, []);
  // Store-wide: 3 + 4 + 2 sets owned; HM-01 loses one set to a damaged pressure bag.
  assert.strictEqual(r.totals.heatersInStore, 9);
  assert.strictEqual(r.totals.availableAll, 2 + 4 + 2);
  // Width 1000 is on the edge of HM-01 and HM-02.
  const edge = call('heaterSearch', { width: 1000, rating: 800, plies: 4 }, t).data;
  assert.deepStrictEqual(edge.suitable.map((s) => s.model.ModelID), ['HM-01', 'HM-02']);
  // Rating too high for anything.
  assert.strictEqual(call('heaterSearch', { width: 1200, rating: 5000 }, t).data.suitable.length, 0);
});

test('nextNumber gives sequential padded numbers', () => {
  const { ctx } = freshApp();
  assert.strictEqual(ctx.nextNumber('request', 'RTGH'), 'RTGH0001');
  assert.strictEqual(ctx.nextNumber('request', 'RTGH'), 'RTGH0002');
  assert.strictEqual(ctx.nextNumber('ticket', 'HEATER_'), 'HEATER_0001');
});

test('queueMail only mails the company inbox and logs to the outbox', () => {
  const { ctx } = freshApp();
  assert.match(ctx.queueMail('TEST', 'R1', 'a@x.com', '', 'Hi', '<b>Hi</b>'), /not set/);
  assert.strictEqual(ctx.__mails.length, 0);
  ctx.updateWhere('Settings', 'Key', 'CompanyInbox', { Value: 'me@company.com' });
  ctx.queueMail('TEST', 'R2', 'a@x.com', 'b@x.com', 'Hi', '<b>Hi</b>');
  assert.strictEqual(ctx.__mails.length, 1);
  assert.strictEqual(ctx.__mails[0].to, 'me@company.com');
  assert.strictEqual(JSON.parse(ctx.__mails[0].body).to, 'a@x.com');
  assert.strictEqual(ctx.readTable('MailOutbox').length, 2);
});

test('fake sha256 matches the real thing', () => {
  const crypto = require('crypto');
  const GasFake = require('../docs/assets/js/gas-fake.js');
  for (const s of ['', 'abc', 'salt:pässwörd', 'x'.repeat(200)]) {
    const want = crypto.createHash('sha256').update(s).digest('base64');
    const ctxBytes = GasFake.sha256(Array.from(Buffer.from(s, 'utf8')));
    assert.strictEqual(GasFake.base64(ctxBytes), want, s);
  }
});

test('resetAdminPassword recovers a locked-out admin', () => {
  const { ctx, call } = freshApp();
  for (let i = 0; i < 5; i++) call('login', { userId: 'admin', password: 'x' });
  const temp = /temporary password: (\S+)/.exec(ctx.resetAdminPassword())[1];
  assert.ok(call('login', { userId: 'admin', password: temp }).ok);
});

test('selection guide decides suitable heaters when it has rows', () => {
  const { ctx, temp, call } = freshApp();
  const t = call('login', { userId: 'admin', password: temp }).data.token;
  ctx.appendRow('HeaterSelection', { BeltWidth_mm: 1200, BeltRating: '1250', Plies: 4, HeaterIDs: 'HM-03, HM-01' });
  ctx.appendRow('HeaterSelection', { BeltWidth_mm: 2000, BeltRating: 'ST1000', Plies: '', HeaterIDs: 'HM-02' });
  const r = call('heaterSearch', { width: 1200, rating: 1250, plies: 4 }, t).data;
  // The guide overrides the width ranges: HM-02 covers 1200 mm by range but is not in the guide row.
  assert.deepStrictEqual(r.suitable.map((s) => s.model.ModelID).sort(), ['HM-01', 'HM-03']);
  assert.deepStrictEqual(call('heaterSearch', { width: 2000, rating: 'ST1000' }, t).data.suitable.map((s) => s.model.ModelID), ['HM-02']);
  // A plain number is a fabric belt, so it does not pick the steel-cord row.
  assert.strictEqual(call('heaterSearch', { width: 2000, rating: 1000 }, t).data.suitable.length, 0);
  const none = call('heaterSearch', { width: 1200, rating: 630, plies: 4 }, t).data;
  assert.strictEqual(none.suitable.length, 0);
  assert.deepStrictEqual(none.guide.optionsForWidth, ['1250/4']);
  assert.strictEqual(call('heaterSearch', { width: 1200, rating: 1250, plies: 5 }, t).data.suitable.length, 0, 'plies must match');
});
