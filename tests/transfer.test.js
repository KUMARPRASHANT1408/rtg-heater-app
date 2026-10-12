// Site transfer approval chain: RTG team -> HOD.
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
  const user = (id, role, team) => {
    const pw = ok('saveUser', { UserID: id, Name: id.toUpperCase(), Role: role, Team: team, Email: id + '@company.com' }, admin).tempPassword;
    return ok('login', { userId: id, password: pw }).token;
  };
  const t = { admin, fm: user('fm01', 'Local', 'FM'), hod: user('hod', 'HOD', 'RTG'), rchief: user('rchief', 'RTG Chief', 'RTG'), fchief: user('fchief', 'FM Chief', 'FM'), rtg: user('rtg01', 'Local', 'RTG') };
  // A heater on site.
  const { RequestNo } = ok('raiseRequest', {
    ModelID: 'HM-02', ConveyorName: 'SAMPLE CNV-205', VendorTeam: 'ABC', VendorSupervisor: 'R', VendorEmployeeID: 'V1', FMRepresentative: 'S', FMEmail: 's@company.com',
    IssueDate: '2026-10-10', ExpectedReturnDate: '2099-01-01', RequestedComponents: [{ name: 'Top platen', qty: 1 }, { name: 'Bottom platen', qty: 1 }]
  }, t.fm);
  const { TicketNo } = ok('decideRequest', { RequestNo, decision: 'approve' }, admin);
  ok('issueTicket', { TicketNo, items: ok('getRequest', { no: TicketNo }, admin).suggestion.picks }, admin);
  const notes = () => ctx.__mails.filter((m) => m.subject.startsWith('[RTG-NOTIFY]')).map((m) => JSON.parse(m.body));
  return { ctx, call, ok, t, TicketNo, notes };
}

const move = (TicketNo, extra) => Object.assign({ TicketNo, ToConveyor: 'SAMPLE CNV-310', Reason: 'Urgent breakdown joint on CNV-310', EmployeeID: 'E77', NewExpectedReturn: '2099-02-01' }, extra);

test('transfer validation', () => {
  const { call, ok, t, TicketNo } = app();
  assert.match(call('raiseTransfer', move(TicketNo, { Reason: 'urgent' }), t.fm).error, /proper reason/);
  assert.match(call('raiseTransfer', move(TicketNo, { ToConveyor: 'sample cnv-205' }), t.fm).error, /already on/);
  assert.match(call('raiseTransfer', move(TicketNo, { NewExpectedReturn: '2020-01-01' }), t.fm).error, /past/);
  assert.strictEqual(ok('raiseTransfer', move(TicketNo), t.fm).TransferNo, 'RTGT0001');
  assert.match(call('raiseTransfer', move(TicketNo), t.fm).error, /already waiting/);
});

test('approval chain: RTG team, then HOD, with the tracker showing who is pending', () => {
  const { call, ok, t, TicketNo, notes } = app();
  const { TransferNo } = ok('raiseTransfer', move(TicketNo), t.fm);
  const tracker = () => ok('listTransfers', {}, t.fm)[0];
  assert.deepStrictEqual(tracker().waitingWith, ['RTG team']);
  assert.deepStrictEqual(tracker().stages.map((s) => s.stage), ['RTG', 'HOD']);
  // Out of order, or the wrong person, is refused.
  assert.match(call('decideTransfer', { TransferNo, decision: 'approve' }, t.hod).error, /not waiting for your approval/);
  assert.match(call('decideTransfer', { TransferNo, decision: 'approve' }, t.fm).error, /not waiting for your approval/);
  assert.match(call('decideTransfer', { TransferNo, decision: 'approve' }, t.fchief).error, /not waiting for your approval/, 'the FM Chief is no longer in the chain');
  assert.ok(ok('listTransfers', {}, t.rtg)[0].canDecide, 'anyone in the RTG team can give the RTG approval');
  assert.strictEqual(ok('dashboard', {}, t.rtg).transfersForMe, 1);
  ok('decideTransfer', { TransferNo, decision: 'approve' }, t.rtg);
  assert.deepStrictEqual(tracker().waitingWith, ['RTG HOD']);
  assert.match(notes().pop().to, /hod@company.com/);
  assert.match(call('decideTransfer', { TransferNo, decision: 'approve' }, t.admin).error, /not waiting/);
  assert.strictEqual(ok('getRequest', { no: TicketNo }, t.fm).ticket.ConveyorName, 'SAMPLE CNV-205', 'no move before the HOD approves');
  assert.strictEqual(ok('decideTransfer', { TransferNo, decision: 'approve' }, t.hod).status, 'Approved');
  const tk = ok('getRequest', { no: TicketNo }, t.fm);
  assert.strictEqual(tk.ticket.ConveyorName, 'SAMPLE CNV-310');
  assert.strictEqual(tk.ticket.ExpectedReturnDate, '2099-02-01');
  assert.strictEqual(tk.transfers[0].stages.filter((s) => s.decision === 'Approved').length, 2);
  const parts = ok('components', {}, t.admin).filter((c) => c.CurrentTicket === TicketNo);
  assert.ok(parts.every((c) => c.CurrentConveyor === 'SAMPLE CNV-310' && c.JointsSinceMaintenance === 2), 'two joints without maintenance');
  const done = notes().pop();
  assert.strictEqual(done.type, 'TRANSFER_APPROVED');
  assert.doesNotMatch(done.cc, /chief/);
  // A second transfer is allowed once the first is finished.
  assert.ok(ok('raiseTransfer', move(TicketNo, { ToConveyor: 'SAMPLE CNV-101' }), t.fm).TransferNo);
});

test('a transfer already waiting for the chiefs from before still finishes', () => {
  const { ctx, call, ok, t, TicketNo } = app();
  const { TransferNo } = ok('raiseTransfer', move(TicketNo), t.fm);
  ok('decideTransfer', { TransferNo, decision: 'approve' }, t.admin);
  ctx.updateWhere('TransferRequests', 'TransferNo', TransferNo, { Status: 'Pending Chiefs' });
  assert.deepStrictEqual(ok('listTransfers', {}, t.fm)[0].waitingWith, ['RTG Chief', 'FM Chief']);
  ok('decideTransfer', { TransferNo, decision: 'approve' }, t.fchief);
  assert.match(call('decideTransfer', { TransferNo, decision: 'approve' }, t.fchief).error, /not waiting/);
  assert.strictEqual(ok('decideTransfer', { TransferNo, decision: 'approve' }, t.rchief).status, 'Approved');
});

test('rejection at any stage stops it and tells FM to return the heater', () => {
  const { call, ok, t, TicketNo, notes } = app();
  const { TransferNo } = ok('raiseTransfer', move(TicketNo), t.fm);
  ok('decideTransfer', { TransferNo, decision: 'approve' }, t.admin);
  assert.match(call('decideTransfer', { TransferNo, decision: 'reject' }, t.hod).error, /reason/);
  ok('decideTransfer', { TransferNo, decision: 'reject', comment: 'Maintenance first' }, t.hod);
  const tr = ok('listTransfers', {}, t.fm)[0];
  assert.strictEqual(tr.Status, 'Rejected');
  assert.deepStrictEqual(tr.waitingWith, []);
  const mail = notes().pop();
  assert.strictEqual(mail.type, 'TRANSFER_REJECTED');
  assert.match(mail.html, /return it to the RTG Store/);
  assert.match(mail.html, /Maintenance first/);
  assert.strictEqual(ok('getRequest', { no: TicketNo }, t.fm).ticket.ConveyorName, 'SAMPLE CNV-205');
});

test('returning the heater cancels a pending transfer', () => {
  const { ok, t, TicketNo } = app();
  ok('raiseTransfer', move(TicketNo), t.fm);
  const items = ok('getRequest', { no: TicketNo }, t.admin).items.map((i) => ({ ComponentID: i.ComponentID, result: 'OK' }));
  ok('returnTicket', { TicketNo, items }, t.admin);
  assert.strictEqual(ok('listTransfers', {}, t.fm)[0].Status, 'Cancelled');
});
