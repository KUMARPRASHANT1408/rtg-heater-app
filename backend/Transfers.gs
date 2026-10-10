// Moving a deployed heater straight to another conveyor without bringing it back to the store.
// Approval chain: RTG admin -> RTG HOD -> RTG Chief AND FM Chief (both, in either order).

var TRF = { RTG: 'Pending RTG', HOD: 'Pending HOD', CHIEFS: 'Pending Chiefs', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
var TRF_DONE = [TRF.APPROVED, TRF.REJECTED, TRF.CANCELLED];
var CHIEF_ROLES = ['RTG Chief', 'FM Chief'];

function approvalsFor_(transferNo) {
  return readTable('Approvals').filter(function (a) { return a.TransferNo === transferNo; });
}

// Which stage this user may decide right now, or null.
function stageFor_(user, t, approvals) {
  if (t.Status === TRF.RTG && user.Role === 'Admin') return 'RTG';
  if (t.Status === TRF.HOD && user.Role === 'HOD') return 'HOD';
  if (t.Status === TRF.CHIEFS && CHIEF_ROLES.indexOf(user.Role) >= 0 &&
      !approvals.some(function (a) { return a.Stage === user.Role; })) return user.Role;
  return null;
}

function roleEmails_(roles) {
  return readTable('Users').filter(function (u) { return roles.indexOf(u.Role) >= 0 && isActive_(u) && u.Email; })
    .map(function (u) { return u.Email; }).join(',');
}

function transferRows_(t, extra) {
  return [['Ticket', t.TicketNo], ['From conveyor', t.FromConveyor], ['To conveyor', t.ToConveyor], ['Reason', t.Reason],
          ['Employee ID', t.EmployeeID], ['New return date', t.NewExpectedReturn]].concat(extra || []);
}

// Human-readable progress for the tracker FM and RTG both see.
function transferStages_(t, approvals) {
  function st(stage) {
    var a = approvals.filter(function (x) { return x.Stage === stage; })[0];
    return { stage: stage, decision: a ? a.Decision : '', by: a ? a.ApproverUserID : '', on: a ? a.DecidedOn : '', comment: a ? a.Comment : '' };
  }
  var stages = [st('RTG'), st('HOD'), st('RTG Chief'), st('FM Chief')];
  var waiting = [];
  if (t.Status === TRF.RTG) waiting = ['RTG team'];
  if (t.Status === TRF.HOD) waiting = ['RTG HOD'];
  if (t.Status === TRF.CHIEFS) waiting = CHIEF_ROLES.filter(function (r) { return !approvals.some(function (a) { return a.Stage === r; }); });
  return { stages: stages, waitingWith: waiting };
}

function raiseTransfer(user, d) {
  required_(d, [['TicketNo', 'Ticket'], ['ToConveyor', 'New conveyor'], ['Reason', 'Reason'], ['EmployeeID', 'Employee ID'], ['NewExpectedReturn', 'New expected return date']]);
  var tk = findOne('Tickets', 'TicketNo', d.TicketNo);
  if (!tk) throw new Error('No such ticket.');
  if ([TKT.ISSUED, TKT.PARTLY].indexOf(tk.Status) < 0) throw new Error('Only a heater that is on site can be moved. This ticket is ' + tk.Status.toLowerCase() + '.');
  if (String(d.ToConveyor).trim().toLowerCase() === String(tk.ConveyorName).trim().toLowerCase()) throw new Error('The heater is already on ' + tk.ConveyorName + '.');
  if (String(d.NewExpectedReturn) < today()) throw new Error('The new return date cannot be in the past.');
  if (String(d.Reason).trim().length < 10) throw new Error('Please give a proper reason (at least 10 characters).');
  var open = readTable('TransferRequests').some(function (x) { return x.TicketNo === tk.TicketNo && TRF_DONE.indexOf(x.Status) < 0; });
  if (open) throw new Error('A transfer for this ticket is already waiting for approval.');

  var no = nextNumber('transfer', 'RTGT');
  var t = { TransferNo: no, TicketNo: tk.TicketNo, FromConveyor: tk.ConveyorName, ToConveyor: String(d.ToConveyor).trim(), Reason: d.Reason,
            EmployeeID: d.EmployeeID, VendorTeam: d.VendorTeam || '', VendorSupervisor: d.VendorSupervisor || '', NewExpectedReturn: d.NewExpectedReturn,
            RaisedBy: user.UserID, RaisedOn: new Date(), Status: TRF.RTG };
  appendRow('TransferRequests', t);
  audit(user.UserID, 'raiseTransfer', no);
  queueMail('TRANSFER_REQUEST', no, [getSetting('RTGTeamMail', ''), roleEmails_(['Admin'])].filter(String).join(','), '',
    'Approval needed: move heater ' + tk.TicketNo + ' to ' + t.ToConveyor + ' (' + no + ')',
    mailHtml_('Transfer request ' + no + ' needs RTG approval', transferRows_(t, [['Raised by', user.Name]]),
      'The heater has been used for a joint and has not had maintenance. Please review in the app.'));
  return { TransferNo: no };
}

function decideTransfer(user, d) {
  var t = findOne('TransferRequests', 'TransferNo', d.TransferNo);
  if (!t) throw new Error('No such transfer request.');
  if (TRF_DONE.indexOf(t.Status) >= 0) throw new Error('This transfer is already ' + t.Status.toLowerCase() + '.');
  var approvals = approvalsFor_(t.TransferNo);
  var stage = stageFor_(user, t, approvals);
  if (!stage) throw new Error('This transfer is not waiting for your approval.');
  if (d.decision !== 'approve' && d.decision !== 'reject') throw new Error('Unknown decision.');
  if (d.decision === 'reject' && !String(d.comment || '').trim()) throw new Error('Please give a reason for rejecting.');

  var now = new Date();
  appendRow('Approvals', { TransferNo: t.TransferNo, Stage: stage, ApproverUserID: user.UserID, Decision: d.decision === 'approve' ? 'Approved' : 'Rejected', Comment: d.comment || '', DecidedOn: now });
  audit(user.UserID, 'decideTransfer', t.TransferNo, { stage: stage, decision: d.decision });
  var tk = findOne('Tickets', 'TicketNo', t.TicketNo);
  var r = findOne('Requests', 'RequestNo', tk.RequestNo);
  var raiser = findOne('Users', 'UserID', t.RaisedBy);
  var fmTo = [contacts_(r), raiser && raiser.Email].filter(String).join(',');

  if (d.decision === 'reject') {
    updateWhere('TransferRequests', 'TransferNo', t.TransferNo, { Status: TRF.REJECTED });
    queueMail('TRANSFER_REJECTED', t.TransferNo, fmTo, getSetting('RTGTeamMail', ''), 'Transfer ' + t.TransferNo + ' rejected: return heater ' + t.TicketNo + ' to RTG Store',
      mailHtml_('Transfer ' + t.TransferNo + ' was rejected by ' + stage, transferRows_(t, [['Rejected by', user.Name + ' (' + stage + ')'], ['Reason', d.comment]]),
        'The heater must not be moved. Please return it to the RTG Store for maintenance.'));
    return { status: TRF.REJECTED };
  }

  var next = null;
  if (stage === 'RTG') next = TRF.HOD;
  else if (stage === 'HOD') next = TRF.CHIEFS;
  else {
    var done = approvals.filter(function (a) { return CHIEF_ROLES.indexOf(a.Stage) >= 0 && a.Decision === 'Approved'; }).length + 1;
    next = done >= CHIEF_ROLES.length ? TRF.APPROVED : TRF.CHIEFS;
  }
  updateWhere('TransferRequests', 'TransferNo', t.TransferNo, { Status: next });

  if (next === TRF.APPROVED) {
    // Move the ticket and every part still on site. Each extra joint counts against maintenance.
    updateWhere('Tickets', 'TicketNo', t.TicketNo, { ConveyorName: t.ToConveyor, ExpectedReturnDate: t.NewExpectedReturn, LastOverdueMail: '' });
    var onSite = {};
    readTable('TicketItems').forEach(function (i) { if (i.TicketNo === t.TicketNo && !i.ConditionIn) onSite[i.ComponentID] = true; });
    updateRows('Components', function (c) {
      return onSite[c.ComponentID] ? { CurrentConveyor: t.ToConveyor, JointsSinceMaintenance: (Number(c.JointsSinceMaintenance) || 0) + 1 } : null;
    });
    queueMail('TRANSFER_APPROVED', t.TransferNo, fmTo, [getSetting('RTGTeamMail', ''), roleEmails_(['HOD', 'RTG Chief', 'FM Chief'])].filter(String).join(','),
      'Transfer ' + t.TransferNo + ' approved: heater ' + t.TicketNo + ' may move to ' + t.ToConveyor,
      mailHtml_('Transfer ' + t.TransferNo + ' is fully approved', transferRows_(t), 'The heater may now be moved. Return it to the RTG Store by the new return date.'));
  } else if (next !== t.Status) {
    var roles = next === TRF.HOD ? ['HOD'] : CHIEF_ROLES;
    queueMail('TRANSFER_APPROVAL', t.TransferNo, roleEmails_(roles), '', 'Approval needed: move heater ' + t.TicketNo + ' to ' + t.ToConveyor + ' (' + t.TransferNo + ')',
      mailHtml_('Transfer request ' + t.TransferNo + ' needs your approval', transferRows_(t, [['Approved so far', approvals.map(function (a) { return a.Stage; }).concat(stage).join(', ')]]),
        'Please approve or reject it in the app.'));
  }
  return { status: next };
}

function listTransfers(user) {
  var all = readTable('Approvals');
  var users = {};
  readTable('Users').forEach(function (u) { users[u.UserID] = u.Name; });
  return readTable('TransferRequests').map(function (t) {
    var approvals = all.filter(function (a) { return a.TransferNo === t.TransferNo; });
    var p = transferStages_(t, approvals);
    p.stages.forEach(function (s) { s.byName = users[s.by] || s.by; });
    return Object.assign({}, t, { RaisedByName: users[t.RaisedBy] || t.RaisedBy, stages: p.stages, waitingWith: p.waitingWith,
                                  canDecide: !!stageFor_(user, t, approvals) });
  }).reverse();
}
