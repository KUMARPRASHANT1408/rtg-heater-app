// The Supabase server (supabase/functions/rtg/core.mjs) on a real Postgres (PGlite, in memory).
// The same story runs on the Google Sheets version and on Postgres; every answer must match.
process.env.TZ = 'Asia/Kolkata'; // the Sheets version formats dates in local time, the server always in India time
const test = require('node:test');
const assert = require('node:assert');
const { makeContext } = require('./gas-fake');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) { /* not installed: skipped below */ }

const KEY = 'k'.repeat(40);

async function pgServer() {
  const { makeServer } = await import('../supabase/functions/rtg/core.mjs');
  const pg = new PGlite();
  const db = {
    run: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((tx) => fn(async (sql, params) => (await tx.query(sql, params || [])).rows))
  };
  const logs = [];
  return { server: makeServer({ db, log: (m) => logs.push(m) }), pg, logs };
}

// Same seed for both: setup + sample data, exported the way the Apps Script relay sends it.
function seed() {
  const ctx = makeContext();
  const temp = /temporary password: (\S+)/.exec(ctx.setup())[1];
  ctx.loadSampleData();
  ctx.updateWhere('Settings', 'Key', 'CompanyInbox', { Value: 'rtg@company.com' });
  const order = Object.keys(ctx.__sheets);
  const tabs = {};
  order.forEach((n) => { tabs[n] = JSON.parse(JSON.stringify(ctx.__sheets[n].data, function (k, v) { return this[k] instanceof Date ? { $d: v } : v; })); });
  return { ctx, temp, order, tabs };
}

// Ignore what is random by design: tokens, temporary passwords, file ids, clock times.
const RANDOM = new Set(['token', 'tempPassword', 'ChecklistFileId']);
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = RANDOM.has(k) ? '*' : norm(v[k]); });
    return o;
  }
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(v)) return 'DATETIME';
  return v;
}

test('Postgres server answers exactly like the Sheets version', { skip: !PGlite && 'npm install first (PGlite)' }, async () => {
  const s = seed();
  const { server, pg } = await pgServer();
  const relay = (action, data, key) => server.handle({ action, key: key || KEY, data });

  assert.match((await server.handle({ action: 'login', data: { userId: 'admin', password: s.temp } })).error, /not connected yet/);
  assert.ok((await relay('relayRegister')).ok);
  assert.match((await relay('relayRegister', {}, 'x'.repeat(40))).error, /different Apps Script/);
  assert.match((await relay('relayMail', {}, 'x'.repeat(40))).error, /not accepted/);
  // Data copied before the last two Requests columns existed: the server adds them itself.
  const reqTab = s.tabs.Requests;
  assert.deepStrictEqual(reqTab[0].slice(-2), ['Plies', 'HeaterAsked']);
  const oldTabs = Object.assign({}, s.tabs, { Requests: reqTab.map((r) => r.slice(0, -2)) });
  const imp = await relay('relayImport', { order: s.order, tabs: oldTabs });
  assert.ok(imp.ok, imp.error);
  assert.match((await relay('relayImport', { order: s.order, tabs: s.tabs })).error, /already copied/);

  const sheets = { call: async (a, d, t) => JSON.parse(JSON.stringify(s.ctx.handle({ action: a, data: d, token: t }))) };
  const postgres = { call: async (a, d, t) => JSON.parse(JSON.stringify(await server.handle({ action: a, data: d, token: t }))) };
  const tokens = { sheets: {}, postgres: {} };
  const both = async (action, data, who, check) => {
    const out = {};
    for (const side of ['sheets', 'postgres']) {
      const b = side === 'sheets' ? sheets : postgres;
      const r = await b.call(action, typeof data === 'function' ? data(side) : data, who && tokens[side][who]);
      out[side] = r;
    }
    assert.deepStrictEqual(norm(out.postgres), norm(out.sheets), action);
    if (check) check(out.postgres);
    return out;
  };
  const login = async (who, userId, pw) => {
    const r = await both('login', (side) => ({ userId, password: typeof pw === 'function' ? pw(side) : pw }));
    tokens.sheets[who] = r.sheets.data.token;
    tokens.postgres[who] = r.postgres.data.token;
  };

  await login('admin', 'admin', s.temp);
  const fmUser = await both('saveUser', { UserID: 'fm01', Name: 'FM One', Role: 'Local', Team: 'FM', Email: 'fm01@company.com' }, 'admin');
  await login('fm', 'fm01', (side) => fmUser[side].data.tempPassword);
  const vUser = await both('saveUser', { UserID: 'vm1', Name: 'Vendor', Role: 'Local', Team: 'RTG Vendor', Email: 'v@x.com' }, 'admin');
  await login('vendor', 'vm1', (side) => vUser[side].data.tempPassword);
  await both('me', {}, 'fm');
  await both('lookups', {}, 'fm');

  const set = [{ name: 'Top platen', qty: 1 }, { name: 'Bottom platen', qty: 1 }, { name: 'Control panel', qty: 1 }, { name: 'Pressure bag', qty: 1 },
    { name: 'Power cable', qty: 2 }, { name: 'Thermocouple', qty: 2 }, { name: 'Side bar', qty: 2 }, { name: 'Clamp bolt set', qty: 1 }];
  const reqData = { ModelID: 'HM-02', ConveyorName: 'SAMPLE CNV-205', VendorTeam: 'ABC Belting', VendorSupervisor: 'R. Singh', VendorEmployeeID: 'V123',
    FMRepresentative: 'S. Das', FMEmail: 'sdas@company.com', IssueDate: '2026-10-10', ExpectedReturnDate: '2026-10-12', RequestedComponents: set };
  await both('raiseRequest', Object.assign({}, reqData, { VendorTeam: '' }), 'fm', (r) => assert.match(r.error, /Vendor team/));
  await both('raiseRequest', reqData, 'fm', (r) => assert.strictEqual(r.data.RequestNo, 'RTGH0001'));
  await both('decideRequest', { RequestNo: 'RTGH0001', decision: 'approve' }, 'fm', (r) => assert.match(r.error, /permission/));
  await both('decideRequest', { RequestNo: 'RTGH0001', decision: 'approve' }, 'admin', (r) => assert.strictEqual(r.data.TicketNo, 'HEATER_0001'));
  const det = await both('getRequest', { no: 'HEATER_0001' }, 'admin');
  const picks = det.postgres.data.suggestion.picks;
  await both('issueTicket', { TicketNo: 'HEATER_0001', items: picks.map((p) => ({ ComponentID: p.ComponentID, Qty: p.Qty })) }, 'admin');
  await both('heaterSearch', { width: 1200, rating: 1250 }, 'fm', (r) => assert.match(r.error, /permission/));
  await both('heaterSearch', { width: 1200, rating: 1250 }, 'admin', (r) => assert.strictEqual(r.data.totals.suitableDeployed, 1));
  await both('dashboard', {}, 'admin');
  await both('listRequests', {}, 'fm');

  // FM gives only the belt; the RTG team chooses the heater when approving.
  const beltOnly = Object.assign({}, reqData, { ModelID: '', RequestedComponents: '', BeltWidth_mm: '1200', BeltRating_Nmm: '1250', Plies: '4', HeaterAsked: 'HM-02?' });
  await both('raiseRequest', beltOnly, 'fm', (r) => assert.strictEqual(r.data.RequestNo, 'RTGH0002'));
  await both('getRequest', { no: 'RTGH0002' }, 'fm', (r) => assert.strictEqual(r.data.heaterOptions, undefined));
  await both('getRequest', { no: 'RTGH0002' }, 'admin', (r) => assert.ok(r.data.heaterOptions.some((o) => o.suitable)));
  await both('decideRequest', { RequestNo: 'RTGH0002', decision: 'approve' }, 'admin', (r) => assert.match(r.error, /Choose the heater/));
  await both('decideRequest', { RequestNo: 'RTGH0002', decision: 'approve', ModelID: 'HM-03' }, 'admin', (r) => assert.strictEqual(r.data.TicketNo, 'HEATER_0002'));
  await both('getRequest', { no: 'HEATER_0002' }, 'admin', (r) => assert.strictEqual(r.data.request.Plies, '4'));

  const items = det.postgres.data.items.length ? det.postgres.data.items : (await both('getRequest', { no: 'HEATER_0001' }, 'admin')).postgres.data.items;
  const result = (i) => (i.ComponentName === 'Pressure bag' ? 'Damaged' : i.ComponentID.endsWith('PC2') ? 'Not returned' : 'OK');
  const ret = items.map((i) => ({ ComponentID: i.ComponentID, result: result(i) }));
  await both('returnTicket', { TicketNo: 'HEATER_0001', items: ret, issueText: 'Bag torn' }, 'admin', (r) => assert.strictEqual(r.data.issueNo, 'ISS0001'));
  await both('closeIssue', { IssueNo: 'ISS0001', explanation: 'Vendor pays' }, 'admin');
  const last = items.filter((i) => i.ComponentID.endsWith('PC2')).map((i) => ({ ComponentID: i.ComponentID, result: 'OK' }));
  await both('returnTicket', { TicketNo: 'HEATER_0001', items: last }, 'admin', (r) => assert.strictEqual(r.data.status, 'Closed'));
  const comps = await both('components', {}, 'admin');
  const due = comps.postgres.data.filter((c) => c.MaintenanceStatus === 'Due' && c.Condition === 'OK').map((c) => c.ComponentID);
  assert.ok(due.length > 5);
  await both('maintenance', { ComponentIDs: due.slice(0, 3) }, 'admin');

  // Maintenance log with a checklist photo: stored in Postgres, read back by RTG.
  const file = { name: 'c.jpg', type: 'image/jpeg', data: Buffer.from('fake jpeg').toString('base64') };
  await both('logMaintenance', { ComponentIDs: due.slice(3, 5), WorkDone: 'Cleaned', file }, 'vendor', (r) => assert.strictEqual(r.data.LogNo, 'MNT0001'));
  await both('getChecklist', { LogNo: 'MNT0001' }, 'admin', (r) => assert.strictEqual(Buffer.from(r.data.data, 'base64').toString(), 'fake jpeg'));
  await both('listMaintenanceLogs', {}, 'admin');
  await both('verifyMaintenance', { LogNo: 'MNT0001', decision: 'verify' }, 'admin');

  // Consumables and transfers.
  await both('stockEntry', { ItemID: 'C02', Type: 'Receipt', Qty: 5, BatchNo: 'X1', ExpiryDate: '2099-12-31' }, 'admin');
  await both('stockEntry', { ItemID: 'C02', Type: 'Issue', Qty: 30, Department: 'FM' }, 'admin', (r) => assert.match(r.error, /Only 5/));
  await both('listConsumables', {}, 'fm', (r) => assert.match(r.error, /permission/));
  await both('listConsumables', {}, 'admin');
  await both('consumableDetail', { ItemID: 'C02' }, 'admin');
  await both('consumableItems', {}, 'fm');
  await both('listTransfers', {}, 'fm');

  // Users: password change, delete.
  await both('changePassword', { oldPassword: 'wrong', newPassword: 'abcdefgh1' }, 'fm', (r) => assert.match(r.error, /Current password/));
  await both('deleteUser', { UserID: 'vm1' }, 'admin');
  await both('listUsers', {}, 'admin');
  await both('getRequest', { no: 'HEATER_0001' }, 'admin');

  // Settings page: lists edited in the app, and the logs read straight from Postgres.
  await both('masterSave', { tab: 'Settings', rows: [{ Key: 'OverdueTo', Value: 'a@x.com' }] }, 'admin');
  await both('masterSave', { tab: 'Conveyors', rows: [{ ConveyorName: 'CNV-900', BeltWidth_mm: '1400' }, { ConveyorName: 'SAMPLE CNV-101', Area: 'RM' }] }, 'admin');
  await both('masterDelete', { tab: 'Departments', key: 'RTG' }, 'admin');
  await both('masterList', { tab: 'Conveyors' }, 'admin');
  await both('masterList', { tab: 'Settings' }, 'admin');
  await both('lookups', {}, 'fm');
  await both('adminLog', { log: 'AuditLog' }, 'admin', (r) => assert.strictEqual(r.data.rows[0].Action, 'deleteFromList'));
  await both('adminLog', { log: 'MailOutbox' }, 'admin', (r) => assert.ok(r.data.rows.length > 3));
  await both('adminLog', { log: 'AuditLog' }, 'fm', (r) => assert.match(r.error, /permission/));

  // Same mail, in the same order, waits in the outbox for the Apps Script relay.
  const sheetMails = s.ctx.__mails;
  const pending = (await relay('relayMail')).data;
  assert.deepStrictEqual(pending.map((m) => m.mail.subject), sheetMails.map((m) => m.subject));
  assert.strictEqual(JSON.parse(pending[0].mail.attachments[0].text).type, 'NEW_REQUEST');
  assert.ok((await relay('relayMailDone', { ids: pending.map((m) => m.id) })).ok);
  assert.strictEqual((await relay('relayMail')).data.length, 0);

  // The backup copy has every tab, the audit log included, in the same shape as the Sheet.
  const exp = (await relay('relayExport')).data;
  for (const tab of ['Requests', 'Tickets', 'TicketItems', 'Components', 'Users', 'MaintenanceLogs', 'ConsumableBatches']) {
    const sheet = s.ctx.readTable(tab).length;
    assert.strictEqual(exp.tabs[tab].length - 1, sheet, tab + ' rows');
  }
  assert.ok(exp.tabs.AuditLog.length > 5);
  assert.ok(exp.tabs.MailOutbox.length > 3);

  // Admin-only storage meter.
  assert.match((await server.handle({ action: 'storageInfo', token: tokens.postgres.fm })).error, /permission/);
  const st = await server.handle({ action: 'storageInfo', token: tokens.postgres.admin });
  assert.ok(st.data.dbBytes > 0 && st.data.dbLimit === 500 * 1024 * 1024, JSON.stringify(st));

  // Sessions live in Postgres: logout ends them.
  await both('logout', {}, 'fm');
  assert.ok((await server.handle({ action: 'logout', token: tokens.postgres.fm })).ok);
  assert.ok((await server.handle({ action: 'me', token: tokens.postgres.fm })).auth);

  // Daily overdue job and the admin password reset run through the relay.
  assert.strictEqual((await relay('relayDaily')).data.overdueMails, 0);
  assert.match((await relay('relayResetAdmin')).data.message, /temporary password/);

  // Clear test data empties the logs too, keeping just the "cleared" entry.
  await both('clearTestData', {}, 'admin', (r) => assert.ok(r.ok, r.error));
  const after = (await relay('relayExport')).data;
  assert.strictEqual(after.tabs.Requests.length, 1);
  assert.strictEqual(after.tabs.MailOutbox.length, 1);
  assert.deepStrictEqual(after.tabs.AuditLog.slice(1).map((r) => r[2]), ['clearTestData']);
  assert.ok(after.tabs.Components.slice(1).every((r) => r[s.tabs.Components[0].indexOf('Status')] === 'In store'));
  await pg.close();
});

test('two people saving at the same moment get different numbers', { skip: !PGlite && 'npm install first (PGlite)' }, async () => {
  const s = seed();
  const { server, pg } = await pgServer();
  await server.handle({ action: 'relayRegister', key: KEY });
  await server.handle({ action: 'relayImport', key: KEY, data: { order: s.order, tabs: s.tabs } });
  const admin = (await server.handle({ action: 'login', data: { userId: 'admin', password: s.temp } })).data.token;
  const data = { ModelID: 'HM-01', ConveyorName: 'SAMPLE CNV-101', VendorTeam: 'A', VendorSupervisor: 'B', VendorEmployeeID: 'V1', FMRepresentative: 'C',
    FMEmail: 'c@x.com', IssueDate: '2026-10-10', ExpectedReturnDate: '2026-10-12', RequestedComponents: [{ name: 'Top platen', qty: 1 }] };
  const res = await Promise.all([1, 2, 3, 4].map(() => server.handle({ action: 'raiseRequest', data, token: admin })));
  assert.deepStrictEqual(res.map((r) => r.data.RequestNo).sort(), ['RTGH0001', 'RTGH0002', 'RTGH0003', 'RTGH0004']);
  await pg.close();
});

test('a newer app version adds its new columns by itself', { skip: !PGlite && 'npm install first (PGlite)' }, async () => {
  const s = seed();
  const comps = s.tabs.Components;
  const col = comps[0].indexOf('Remarks');
  s.tabs.Components = comps.map((r) => r.filter((v, i) => i !== col)); // an "old" Sheet without the Remarks column
  const { server, pg } = await pgServer();
  await server.handle({ action: 'relayRegister', key: KEY });
  await server.handle({ action: 'relayImport', key: KEY, data: { order: s.order, tabs: s.tabs } });
  const exp = (await server.handle({ action: 'relayExport', key: KEY })).data;
  assert.ok(exp.tabs.Components[0].includes('Remarks'));
  await pg.close();
});

test('a new copy of the function does not run the table setup again (it deadlocked running requests)', { skip: !PGlite && 'npm install first (PGlite)' }, async () => {
  const { makeServer } = await import('../supabase/functions/rtg/core.mjs');
  const pg = new PGlite();
  let ddl = 0;
  const db = {
    run: (sql) => { ddl++; return pg.exec(sql); },
    tx: (fn) => pg.transaction((tx) => fn(async (sql, params) => (await tx.query(sql, params || [])).rows))
  };
  await makeServer({ db }).init();
  await makeServer({ db }).init();
  await makeServer({ db }).handle({ action: 'me', token: 'x' });
  assert.strictEqual(ddl, 1);
  await pg.close();
});
