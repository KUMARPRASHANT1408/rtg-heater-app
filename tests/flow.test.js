// End-to-end heater lifecycle against the real backend code and the fake Sheet.
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
  const fmPw = ok('saveUser', { UserID: 'fm01', Name: 'FM One', Role: 'Local', Team: 'FM', Email: 'fm01@company.com' }, admin).tempPassword;
  const fm = ok('login', { userId: 'fm01', password: fmPw }).token;
  const notes = () => ctx.__mails.filter((m) => m.subject.startsWith('[RTG-NOTIFY]')).map((m) => JSON.parse(m.body));
  return { ctx, call, ok, admin, fm, notes };
}

const FULL_SET = [
  { name: 'Top platen', qty: 1 }, { name: 'Bottom platen', qty: 1 }, { name: 'Control panel', qty: 1 }, { name: 'Pressure bag', qty: 1 },
  { name: 'Power cable', qty: 2 }, { name: 'Thermocouple', qty: 2 }, { name: 'Side bar', qty: 2 }, { name: 'Clamp bolt set', qty: 1 }
];

function requestData(extra) {
  return Object.assign({
    ModelID: 'HM-02', ConveyorName: 'SAMPLE CNV-205', VendorTeam: 'ABC Belting', VendorSupervisor: 'R. Singh', VendorEmployeeID: 'V123',
    FMRepresentative: 'S. Das', FMEmail: 'sdas@company.com', IssueDate: '2026-10-10', ExpectedReturnDate: '2026-10-12', RequestedComponents: FULL_SET
  }, extra);
}

test('request validation', () => {
  const { call, fm } = app();
  assert.match(call('raiseRequest', requestData({ VendorTeam: '' }), fm).error, /Vendor team name is required/);
  assert.match(call('raiseRequest', requestData({ ExpectedReturnDate: '2026-10-01' }), fm).error, /before the issue date/);
  assert.match(call('raiseRequest', requestData({ RequestedComponents: [] }), fm).error, /at least one component/);
  assert.match(call('raiseRequest', requestData({ RequestedComponents: [{ name: 'Teapot', qty: 1 }] }), fm).error, /not part of this heater/);
});

test('reject sends the vendor/FM a mail with the reason; local users cannot decide', () => {
  const { call, ok, admin, fm, notes } = app();
  const { RequestNo } = ok('raiseRequest', requestData(), fm);
  assert.strictEqual(RequestNo, 'RTGH0001');
  assert.match(call('decideRequest', { RequestNo, decision: 'approve' }, fm).error, /permission/);
  assert.match(call('decideRequest', { RequestNo, decision: 'reject' }, admin).error, /reason/);
  ok('decideRequest', { RequestNo, decision: 'reject', reason: 'No heater free this week' }, admin);
  const mail = notes().find((n) => n.type === 'REQUEST_REJECTED');
  assert.strictEqual(mail.ref, 'RTGH0001');
  assert.match(mail.to, /sdas@company.com/);
  assert.match(mail.to, /fm01@company.com/);
  assert.match(mail.html, /No heater free this week/);
  assert.match(call('decideRequest', { RequestNo, decision: 'approve' }, admin).error, /already rejected/);
});

test('full lifecycle: approve, issue by component, partial return with issue, overdue, close, maintenance', () => {
  const { ctx, call, ok, admin, fm, notes } = app();
  const { RequestNo } = ok('raiseRequest', requestData(), fm);
  const appr = ok('decideRequest', { RequestNo, decision: 'approve' }, admin);
  assert.strictEqual(appr.TicketNo, 'HEATER_0001');
  assert.match(notes().find((n) => n.type === 'REQUEST_APPROVED').subject, /HEATER_0001/);

  // Search by ticket number; admin gets a suggested pick of 11 parts, all from one set.
  const det = ok('getRequest', { no: 'heater_0001' }, admin);
  assert.strictEqual(det.ticket.Status, 'Awaiting pickup');
  assert.strictEqual(det.suggestion.short.length, 0);
  assert.strictEqual(det.suggestion.picks.length, 11);
  assert.strictEqual(new Set(det.suggestion.picks.map((p) => p.SetNo)).size, 1);
  assert.strictEqual(ok('getRequest', { no: 'RTGH0001' }, fm).suggestion, undefined, 'only admins get the pick list');

  // Issue; a damaged part can't be issued.
  assert.match(call('issueTicket', { TicketNo: 'HEATER_0001', items: [{ ComponentID: 'HM-01-S3-PB' }] }, admin).error, /different heater model/);
  ok('issueTicket', { TicketNo: 'HEATER_0001', items: det.suggestion.picks.map((p) => ({ ComponentID: p.ComponentID, Qty: p.Qty })) }, admin);
  assert.match(call('issueTicket', { TicketNo: 'HEATER_0001', items: det.suggestion.picks }, admin).error, /already issued/);
  const s1 = ok('heaterSearch', { width: 1200, rating: 1250 }, fm);
  assert.strictEqual(s1.totals.suitableAvailable, 3);
  assert.strictEqual(s1.totals.suitableDeployed, 1);
  assert.deepStrictEqual(s1.deployments.map((d) => d.conveyor), ['SAMPLE CNV-205']);

  // Overdue: a mail on the first late day, not twice the same day.
  ctx.updateWhere('Tickets', 'TicketNo', 'HEATER_0001', { ExpectedReturnDate: '2020-01-01' });
  assert.strictEqual(ctx.sendOverdueMails(), 1);
  assert.strictEqual(ctx.sendOverdueMails(), 0);
  const od = notes().find((n) => n.type === 'OVERDUE');
  assert.match(od.subject, /HEATER_0001/);
  assert.ok(ok('listRequests', {}, fm)[0].Overdue);

  // Return: one cable still on site, one thermocouple missing, the pressure bag damaged.
  const items = ok('getRequest', { no: 'HEATER_0001' }, admin).items;
  const result = (i) => (i.ComponentName === 'Pressure bag' ? 'Damaged' : i.ComponentID.endsWith('-T2') ? 'Missing' : i.ComponentID.endsWith('PC2') ? 'Not returned' : 'OK');
  const ret = items.map((i) => ({ ComponentID: i.ComponentID, result: result(i), remarks: result(i) === 'Damaged' ? 'Torn' : '' }));
  assert.match(call('returnTicket', { TicketNo: 'HEATER_0001', items: ret }, admin).error, /Describe the damaged or missing/);
  const r1 = ok('returnTicket', { TicketNo: 'HEATER_0001', items: ret, issueText: 'Bag torn, one thermocouple not returned' }, admin);
  assert.strictEqual(r1.status, 'Returned with issue');
  assert.strictEqual(r1.issueNo, 'ISS0001');
  assert.strictEqual(r1.stillOut, 1);
  const issueMail = notes().find((n) => n.type === 'HEATER_ISSUE');
  assert.match(issueMail.html, /kindly give an explanation/i);
  assert.match(issueMail.html, /Missing/);

  // Overdue reminders continue while a part is still on site (next day).
  ctx.updateWhere('Tickets', 'TicketNo', 'HEATER_0001', { LastOverdueMail: '2020-01-01' });
  assert.strictEqual(ctx.sendOverdueMails(), 1);

  // Closing the issue leaves the ticket partly returned; returning the last cable closes it.
  ok('closeIssue', { IssueNo: 'ISS0001', explanation: 'Vendor will pay for the bag' }, admin);
  assert.strictEqual(ok('getRequest', { no: 'HEATER_0001' }, admin).ticket.Status, 'Partly returned');
  const last = items.filter((i) => i.ComponentID.endsWith('PC2')).map((i) => ({ ComponentID: i.ComponentID, result: 'OK' }));
  assert.strictEqual(ok('returnTicket', { TicketNo: 'HEATER_0001', items: last }, admin).status, 'Closed');
  assert.strictEqual(ctx.sendOverdueMails(), 0, 'no reminders after closing');

  // Returned parts are "maintenance due": not available until maintenance is recorded.
  const comps = ok('components', {}, admin);
  const due = comps.filter((c) => c.MaintenanceStatus === 'Due');
  assert.strictEqual(due.length, 10);
  assert.ok(comps.some((c) => c.Status === 'Missing'));
  assert.strictEqual(ok('heaterSearch', { width: 1200, rating: 1250 }, fm).totals.suitableAvailable, 3);
  const dueOk = due.filter((c) => c.Condition === 'OK').map((c) => c.ComponentID);
  ok('maintenance', { ComponentIDs: dueOk }, admin);
  // Still 3: the set's pressure bag is damaged and a thermocouple is missing.
  assert.strictEqual(ok('heaterSearch', { width: 1200, rating: 1250 }, fm).totals.suitableAvailable, 3);
  const bag = due.find((c) => c.Condition === 'Damaged').ComponentID;
  ok('maintenance', { ComponentIDs: [bag], repaired: true }, admin);
  const tc = comps.find((c) => c.Status === 'Missing').ComponentID;
  ok('markFound', { ComponentID: tc }, admin);
  ok('maintenance', { ComponentIDs: [tc] }, admin);
  assert.strictEqual(ok('heaterSearch', { width: 1200, rating: 1250 }, fm).totals.suitableAvailable, 4);

  const dash = ok('dashboard', {}, admin);
  assert.deepStrictEqual([dash.pending, dash.awaiting, dash.onSite, dash.overdue, dash.openIssues], [0, 0, 0, 0, 0]);
});

test('issuing part of a lot splits it so the rest stays in store', () => {
  const { ctx, ok, admin, fm } = app();
  ctx.appendRow('ComponentTypes', { ModelID: 'HM-03', ComponentName: 'Spare bolts', QtyPerSet: 4, IsSerialised: 'N' });
  ctx.appendRow('Components', { ComponentID: 'HM-03-BOLTS', ModelID: 'HM-03', SetNo: '', ComponentName: 'Spare bolts', Qty: 10, Condition: 'OK', Status: 'In store', MaintenanceStatus: 'OK', JointsSinceMaintenance: 0 });
  const { RequestNo } = ok('raiseRequest', requestData({ ModelID: 'HM-03', RequestedComponents: [{ name: 'Spare bolts', qty: 4 }] }), fm);
  const { TicketNo } = ok('decideRequest', { RequestNo, decision: 'approve' }, admin);
  const pick = ok('getRequest', { no: TicketNo }, admin).suggestion.picks;
  assert.deepStrictEqual(pick.map((p) => [p.ComponentID, p.Qty]), [['HM-03-BOLTS', 4]]);
  ok('issueTicket', { TicketNo, items: pick }, admin);
  const comps = ok('components', {}, admin).filter((c) => c.ComponentName === 'Spare bolts');
  assert.deepStrictEqual(comps.map((c) => [c.ComponentID, c.Qty, c.Status]), [['HM-03-BOLTS', 6, 'In store'], ['HM-03-BOLTS/' + TicketNo, 4, 'Issued']]);
});

test('FM hands back, RTG inspects, FM explains, RTG closes', () => {
  const { ctx, call, ok, admin, fm, notes } = app();
  const { RequestNo } = ok('raiseRequest', requestData(), fm);
  const { TicketNo } = ok('decideRequest', { RequestNo, decision: 'approve' }, admin);
  const picks = ok('getRequest', { no: TicketNo }, admin).suggestion.picks;
  ok('issueTicket', { TicketNo, items: picks }, admin);
  const items = ok('getRequest', { no: TicketNo }, fm).items;
  // A vendor login (not FM, did not raise it) cannot hand it back.
  const vpw = ok('saveUser', { UserID: 'v1', Name: 'Vendor', Role: 'Local', Team: 'Vendor' }, admin).tempPassword;
  const vendor = ok('login', { userId: 'v1', password: vpw }).token;
  assert.match(call('declareReturn', { TicketNo, ComponentIDs: items.map((i) => i.ComponentID) }, vendor).error, /Only the FM team/);
  // FM hands back everything; overdue reminders stop while RTG inspects.
  ok('declareReturn', { TicketNo, ComponentIDs: items.map((i) => i.ComponentID), note: 'Joint done' }, fm);
  assert.match(call('declareReturn', { TicketNo, ComponentIDs: items.map((i) => i.ComponentID) }, fm).error, /at least one/);
  assert.ok(notes().some((n) => n.type === 'RETURN_DECLARED'));
  ctx.updateWhere('Tickets', 'TicketNo', TicketNo, { ExpectedReturnDate: '2020-01-01' });
  assert.strictEqual(ctx.sendOverdueMails(), 0);
  // RTG finds the bag damaged.
  const ret = items.map((i) => ({ ComponentID: i.ComponentID, result: i.ComponentName === 'Pressure bag' ? 'Damaged' : 'OK' }));
  const { issueNo } = ok('returnTicket', { TicketNo, items: ret, issueText: 'Pressure bag torn' }, admin);
  assert.match(notes().find((n) => n.type === 'HEATER_ISSUE').html, /action you will take/);
  // RTG can't close before FM explains (unless they type it in).
  assert.match(call('closeIssue', { IssueNo: issueNo }, admin).error, /not explained/);
  assert.match(call('explainIssue', { IssueNo: issueNo, explanation: 'Sharp edge on belt' }, fm).error, /Action you will take/);
  ok('explainIssue', { IssueNo: issueNo, explanation: 'Sharp edge on belt', actionPlan: 'Will trim edges before placing the bag' }, fm);
  const ex = notes().find((n) => n.type === 'ISSUE_EXPLAINED');
  assert.match(ex.html, /trim edges/);
  assert.strictEqual(ok('getRequest', { no: TicketNo }, fm).ticket.Status, 'Returned with issue');
  assert.strictEqual(ok('closeIssue', { IssueNo: issueNo, remark: 'Accepted' }, admin).status, 'Closed');
  assert.ok(notes().some((n) => n.type === 'TICKET_CLOSED'));
});

test('notification mail is readable and carries the JSON as an attachment', () => {
  const { ctx, ok, fm } = app();
  ok('raiseRequest', requestData(), fm);
  const m = ctx.__mails.find((x) => x.subject === '[RTG-NOTIFY] NEW_REQUEST RTGH0001');
  assert.match(m.htmlBody, /New heater request/);
  assert.doesNotMatch(m.htmlBody, /"type":/);
  assert.strictEqual(m.attachments[0].name, 'rtg-notify.json');
  assert.strictEqual(JSON.parse(m.attachments[0].data).type, 'NEW_REQUEST');
});
