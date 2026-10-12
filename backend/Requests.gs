// Heater request -> approval -> ticket -> component-wise issue -> return/inspection -> close or issue.

var REQ = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' };
var TKT = { AWAITING: 'Awaiting pickup', ISSUED: 'Issued', PARTLY: 'Partly returned', ISSUE: 'Returned with issue', CLOSED: 'Closed' };
var OPEN_TICKET = [TKT.ISSUED, TKT.PARTLY, TKT.ISSUE];

function required_(d, fields) {
  fields.forEach(function (f) {
    if (!String(d[f[0]] === undefined ? '' : d[f[0]]).trim()) throw new Error(f[1] + ' is required.');
  });
}

function parseList_(v) {
  if (!v) return [];
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return []; }
}

function mailHtml_(title, rows, note) {
  var url = getSetting('AppUrl', '');
  return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f1b2d">' +
    '<h2 style="color:#1f3a68;margin:0 0 12px">' + escHtml_(title) + '</h2>' +
    (note ? '<p>' + escHtml_(note) + '</p>' : '') +
    '<table style="border-collapse:collapse">' + rows.map(function (r) {
      return '<tr><td style="padding:4px 14px 4px 0;color:#4a5568">' + escHtml_(r[0]) + '</td><td style="padding:4px 0"><b>' + escHtml_(r[1]) + '</b></td></tr>';
    }).join('') + '</table>' +
    (url ? '<p><a href="' + escHtml_(url) + '">Open RTG Heater Management</a></p>' : '') +
    '<p style="color:#718096;font-size:12px">Sent automatically by the RTG Heater Management app.</p></div>';
}

function escHtml_(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function contacts_(req) {
  var raiser = findOne('Users', 'UserID', req.RaisedBy);
  return [req.FMEmail, raiser && raiser.Email].filter(function (x) { return x; }).join(',');
}

function itemsTable_(items) {
  return items.map(function (i) { return [i.ComponentID, i.ComponentName + (Number(i.QtyOut) > 1 ? ' x' + i.QtyOut : '')]; });
}

// ---------- request ----------
// FM gives the belt details (and the heater number if they know it); the RTG team chooses the heater when approving.
// The store may also name the heater and parts straight away (ModelID + RequestedComponents).
function raiseRequest(user, d) {
  required_(d, [['ConveyorName', 'Conveyor name'], ['VendorTeam', 'Vendor team name'], ['VendorSupervisor', 'Vendor supervisor name'],
                ['VendorEmployeeID', 'Vendor employee ID'], ['FMRepresentative', 'FM representative'], ['IssueDate', 'Date of issue'], ['ExpectedReturnDate', 'Expected return date']]);
  if (String(d.ExpectedReturnDate) < String(d.IssueDate)) throw new Error('Expected return date cannot be before the issue date.');
  var model = null, comps = [];
  if (d.ModelID) {
    model = findOne('HeaterModels', 'ModelID', d.ModelID);
    if (!model) throw new Error('Unknown heater model.');
    var names = readTable('ComponentTypes').filter(function (t) { return t.ModelID === d.ModelID; }).map(function (t) { return t.ComponentName; });
    comps = parseList_(d.RequestedComponents).filter(function (c) { return Number(c.qty) > 0; });
    if (!comps.length) throw new Error('Choose at least one component.');
    comps.forEach(function (c) { if (names.indexOf(c.name) < 0) throw new Error('"' + c.name + '" is not part of this heater.'); });
  } else {
    required_(d, [['BeltWidth_mm', 'Belt width'], ['BeltRating_Nmm', 'Belt rating']]);
    if (!(Number(d.BeltWidth_mm) > 0)) throw new Error('Belt width must be a number in mm.');
    if (!normRating(d.BeltRating_Nmm)) throw new Error('Type the belt rating as a number like 1000, or ST1000 (ST-1600 where RTG writes it so) for a steel-cord belt.');
    if (/^ST/.test(normRating(d.BeltRating_Nmm))) d.Plies = '';
    if (d.Plies !== undefined && d.Plies !== '' && !(Number(d.Plies) > 0)) throw new Error('Plies must be a number.');
  }

  var no = nextNumber('request', 'RTGH');
  var row = {
    RequestNo: no, RaisedBy: user.UserID, RaisedOn: new Date(), ModelID: model ? model.ModelID : '', ConveyorName: d.ConveyorName,
    BeltWidth_mm: d.BeltWidth_mm || '', BeltRating_Nmm: String(d.BeltRating_Nmm || '').replace(/\s+/g, '').toUpperCase(), Plies: d.Plies || '',
    HeaterAsked: String(d.HeaterAsked || '').trim(), VendorTeam: d.VendorTeam, VendorSupervisor: d.VendorSupervisor,
    VendorEmployeeID: d.VendorEmployeeID, FMRepresentative: d.FMRepresentative, FMEmail: d.FMEmail || '', IssueDate: d.IssueDate,
    ExpectedReturnDate: d.ExpectedReturnDate, RequestedComponents: JSON.stringify(comps.map(function (c) { return { name: c.name, qty: Number(c.qty) }; })),
    Status: REQ.PENDING
  };
  appendRow('Requests', row);
  audit(user.UserID, 'raiseRequest', no);
  queueMail('NEW_REQUEST', no, getSetting('RTGTeamMail', ''), '', 'New heater request ' + no,
    mailHtml_('New heater request ' + no, [['Heater', model ? model.ModelName : (row.HeaterAsked ? row.HeaterAsked + ' (asked by FM)' : 'To be chosen by RTG')],
      ['Belt', beltText_(row)], ['Conveyor', d.ConveyorName], ['Vendor team', d.VendorTeam],
      ['FM representative', d.FMRepresentative], ['Issue date', d.IssueDate], ['Expected return', d.ExpectedReturnDate], ['Raised by', user.Name]],
      model ? 'Please approve or reject it in the app.' : 'Please choose a heater for this belt and approve, or reject it, in the app.'));
  return { RequestNo: no };
}

// "1200 mm · 1000 N/mm · 4 plies"
function beltText_(r) {
  return [r.BeltWidth_mm ? r.BeltWidth_mm + ' mm' : '', r.BeltRating_Nmm ? r.BeltRating_Nmm + ' N/mm' : '', r.Plies ? r.Plies + ' plies' : '']
    .filter(String).join(' · ');
}

// A full set of the heater's parts, as asked for when the RTG team picks the heater.
function fullSet_(modelId) {
  return readTable('ComponentTypes').filter(function (t) { return t.ModelID === modelId; })
    .map(function (t) { return { name: t.ComponentName, qty: Number(t.QtyPerSet) || 1 }; });
}

function listRequests() {
  var tickets = {};
  readTable('Tickets').forEach(function (t) { tickets[t.TicketNo] = t; });
  var models = {};
  readTable('HeaterModels').forEach(function (m) { models[m.ModelID] = m.ModelName; });
  var openIssues = {};
  readTable('Issues').forEach(function (i) { if (i.Status !== 'Closed') openIssues[i.TicketNo] = true; });
  var t = today();
  return readTable('Requests').map(function (r) {
    var tk = r.TicketNo ? tickets[r.TicketNo] : null;
    var status = tk ? tk.Status : r.Status;
    var expected = tk ? tk.ExpectedReturnDate : r.ExpectedReturnDate;
    return {
      RequestNo: r.RequestNo, TicketNo: r.TicketNo, ModelName: models[r.ModelID] || r.ModelID || '', Belt: beltText_(r), HeaterAsked: r.HeaterAsked || '', ConveyorName: tk ? tk.ConveyorName : r.ConveyorName,
      VendorTeam: r.VendorTeam, FMRepresentative: r.FMRepresentative, RaisedOn: r.RaisedOn, IssueDate: r.IssueDate, ExpectedReturnDate: expected,
      Status: status, Overdue: !!tk && OPEN_TICKET.indexOf(tk.Status) >= 0 && isOverdue(expected, t), OpenIssue: !!openIssues[r.TicketNo]
    };
  }).reverse();
}

// Search by request number or ticket number.
function getRequest(user, d) {
  var q = String(d.no || '').trim().toUpperCase();
  var r = readTable('Requests').filter(function (x) { return String(x.RequestNo).toUpperCase() === q || String(x.TicketNo).toUpperCase() === q; })[0];
  if (!r) throw new Error('No request or ticket found for "' + d.no + '".');
  var tk = r.TicketNo ? findOne('Tickets', 'TicketNo', r.TicketNo) : null;
  var items = tk ? readTable('TicketItems').filter(function (i) { return i.TicketNo === tk.TicketNo; }) : [];
  var issues = tk ? readTable('Issues').filter(function (i) { return i.TicketNo === tk.TicketNo; }) : [];
  var transfers = tk ? listTransfers(user).filter(function (x) { return x.TicketNo === tk.TicketNo; }) : [];
  var model = findOne('HeaterModels', 'ModelID', r.ModelID);
  var raiser = findOne('Users', 'UserID', r.RaisedBy);
  r.RequestedComponents = parseList_(r.RequestedComponents);
  var out = { request: r, ticket: tk, items: items, issues: issues, transfers: transfers, model: model, raisedByName: raiser ? raiser.Name : r.RaisedBy,
              overdue: !!tk && OPEN_TICKET.indexOf(tk.Status) >= 0 && isOverdue(tk.ExpectedReturnDate, today()) };
  out.belt = beltText_(r);
  // The RTG team picks the heater: the suitable ones for this belt, with what is ready in the store.
  if (isRtgTeam_(user) && r.Status === REQ.PENDING) {
    var hd = heaterData_();
    var found = r.BeltWidth_mm ? heaterSearch(hd, r.BeltWidth_mm, r.BeltRating_Nmm, r.Plies) : { suitable: [] };
    var stats = {};
    found.suitable.forEach(function (x) { stats[x.model.ModelID] = x; });
    out.heaterOptions = hd.models.map(function (m) {
      var x = stats[m.ModelID];
      return { ModelID: m.ModelID, ModelName: m.ModelName, suitable: !!x, availableSets: x ? x.availableSets : null, deployedCount: x ? x.deployedCount : null };
    }).sort(function (a, b) { return (b.suitable - a.suitable) || ((b.availableSets || 0) - (a.availableSets || 0)); });
  }
  if (isRtgTeam_(user) && tk && tk.Status === TKT.AWAITING) {
    var comps = readTable('Components'), from = partModels(readTable('HeaterModels'), r.ModelID);
    out.suggestion = pickComponents(comps, r.ModelID, r.RequestedComponents, from);
    out.usable = comps.filter(function (c) { return from.indexOf(c.ModelID) >= 0 && isUsable(c); });
  }
  return out;
}

// ---------- approve / reject ----------
function decideRequest(admin, d) {
  var r = findOne('Requests', 'RequestNo', d.RequestNo);
  if (!r) throw new Error('No such request.');
  if (r.Status !== REQ.PENDING) throw new Error('This request is already ' + r.Status.toLowerCase() + '.');
  var model = findOne('HeaterModels', 'ModelID', r.ModelID) || {};
  var rejectCC = getSetting('RejectCC', '');
  if (d.decision === 'reject') {
    if (!String(d.reason || '').trim()) throw new Error('Please give a reason for rejecting.');
    updateWhere('Requests', 'RequestNo', r.RequestNo, { Status: REQ.REJECTED, DecidedBy: admin.UserID, DecidedOn: new Date(), RejectReason: d.reason });
    audit(admin.UserID, 'rejectRequest', r.RequestNo, { reason: d.reason });
    queueMail('REQUEST_REJECTED', r.RequestNo, contacts_(r), rejectCC, 'Heater request ' + r.RequestNo + ' rejected by RTG team',
      mailHtml_('Request ' + r.RequestNo + ' has been rejected by the RTG team', [['Heater', model.ModelName || beltText_(r)], ['Conveyor', r.ConveyorName], ['Vendor team', r.VendorTeam], ['Reason', d.reason]]));
    return { status: REQ.REJECTED };
  }
  if (d.decision !== 'approve') throw new Error('Unknown decision.');
  var modelId = d.ModelID || r.ModelID;
  if (!modelId) throw new Error('Choose the heater to give for this belt.');
  model = findOne('HeaterModels', 'ModelID', modelId);
  if (!model) throw new Error('Unknown heater model.');
  var patch = { Status: REQ.APPROVED, DecidedBy: admin.UserID, DecidedOn: new Date() };
  if (modelId !== r.ModelID) { patch.ModelID = modelId; patch.RequestedComponents = JSON.stringify(fullSet_(modelId)); }
  var ticketNo = nextNumber('ticket', 'HEATER_');
  patch.TicketNo = ticketNo;
  updateWhere('Requests', 'RequestNo', r.RequestNo, patch);
  appendRow('Tickets', { TicketNo: ticketNo, RequestNo: r.RequestNo, ModelID: modelId, Status: TKT.AWAITING, ConveyorName: r.ConveyorName, ExpectedReturnDate: r.ExpectedReturnDate });
  audit(admin.UserID, 'approveRequest', r.RequestNo, { ticket: ticketNo });
  queueMail('REQUEST_APPROVED', r.RequestNo, contacts_(r), '', 'Heater request ' + r.RequestNo + ' approved: ticket ' + ticketNo,
    mailHtml_('Request ' + r.RequestNo + ' is approved. Your ticket number is ' + ticketNo, [['Heater', model.ModelName], ['Conveyor', r.ConveyorName], ['Expected return', r.ExpectedReturnDate]],
      'Bring this ticket number to the RTG Store to collect the heater.'));
  return { status: REQ.APPROVED, TicketNo: ticketNo };
}

// ---------- issue at the store ----------
// d.items = [{ComponentID, Qty}] chosen by the RTG person.
function issueTicket(admin, d) {
  var tk = findOne('Tickets', 'TicketNo', d.TicketNo);
  if (!tk) throw new Error('No such ticket.');
  if (tk.Status !== TKT.AWAITING) throw new Error('This ticket is already ' + tk.Status.toLowerCase() + '.');
  var chosen = parseList_(d.items);
  if (!chosen.length) throw new Error('Choose the components being handed over.');
  var comps = readTable('Components'), from = partModels(readTable('HeaterModels'), tk.ModelID);
  var byId = {};
  comps.forEach(function (c) { byId[c.ComponentID] = c; });
  var seen = {};
  var items = [], patches = {}, splits = [];
  chosen.forEach(function (ch) {
    var c = byId[ch.ComponentID];
    if (!c) throw new Error('Unknown component ' + ch.ComponentID + '.');
    if (seen[c.ComponentID]) throw new Error(c.ComponentID + ' is listed twice.');
    seen[c.ComponentID] = true;
    if (from.indexOf(c.ModelID) < 0) throw new Error(c.ComponentID + ' belongs to a different heater.');
    if (!isUsable(c)) throw new Error(c.ComponentID + ' is not available (' + [c.Status, c.Condition, c.MaintenanceStatus === MAINT.DUE ? 'maintenance due' : ''].filter(String).join(', ') + ').');
    var have = Number(c.Qty) || 1, qty = Number(ch.Qty) || have;
    if (qty > have) throw new Error('Only ' + have + ' of ' + c.ComponentID + ' in store.');
    var issuedId = c.ComponentID;
    var issuedPatch = { Status: STATUS.ISSUED, CurrentTicket: tk.TicketNo, CurrentConveyor: tk.ConveyorName, JointsSinceMaintenance: (Number(c.JointsSinceMaintenance) || 0) + 1 };
    if (qty < have) {
      // Part of a lot (e.g. 4 of 10 bolts): keep the rest in store, track the issued part as its own row.
      issuedId = c.ComponentID + '/' + tk.TicketNo;
      patches[c.ComponentID] = { Qty: have - qty };
      splits.push(Object.assign({}, c, issuedPatch, { ComponentID: issuedId, Qty: qty, Remarks: 'Split from ' + c.ComponentID }));
    } else {
      patches[c.ComponentID] = issuedPatch;
    }
    items.push({ TicketNo: tk.TicketNo, ComponentID: issuedId, ComponentName: c.ComponentName, SetNo: c.SetNo, QtyOut: qty, ConditionOut: c.Condition });
  });
  updateMany('Components', 'ComponentID', patches);
  appendRows('Components', splits);
  appendRows('TicketItems', items);
  updateWhere('Tickets', 'TicketNo', tk.TicketNo, { Status: TKT.ISSUED, IssuedBy: admin.UserID, IssuedOn: new Date() });
  audit(admin.UserID, 'issueTicket', tk.TicketNo, { items: items.length });
  var r = findOne('Requests', 'RequestNo', tk.RequestNo);
  queueMail('HEATER_ISSUED', tk.TicketNo, contacts_(r), '', 'Heater issued on ticket ' + tk.TicketNo,
    mailHtml_('Heater issued on ticket ' + tk.TicketNo, [['Conveyor', tk.ConveyorName], ['Return by', tk.ExpectedReturnDate]].concat(itemsTable_(items)),
      'These components were handed over. All of them must come back to the RTG Store by the return date.'));
  return { status: TKT.ISSUED, items: items.length };
}

// ---------- return and inspection ----------
// d.items = [{ComponentID, result: 'OK' | 'Damaged' | 'Missing' | 'Not returned', remarks}], d.issueText for damaged/missing.
function returnTicket(admin, d) {
  var tk = findOne('Tickets', 'TicketNo', d.TicketNo);
  if (!tk) throw new Error('No such ticket.');
  if (OPEN_TICKET.indexOf(tk.Status) < 0) throw new Error('This ticket is ' + tk.Status.toLowerCase() + ', nothing to return.');
  var results = {};
  parseList_(d.items).forEach(function (i) { results[i.ComponentID] = i; });
  var outstanding = readTable('TicketItems').filter(function (i) { return i.TicketNo === tk.TicketNo && !i.ConditionIn; });
  if (!outstanding.length) throw new Error('All components on this ticket are already returned.');
  var now = new Date(), compPatch = {}, problems = [], stillOut = 0, returned = 0;
  var valid = ['OK', 'Damaged', 'Missing', 'Not returned'];
  outstanding.forEach(function (i) {
    var res = results[i.ComponentID];
    var result = res ? res.result : 'Not returned';
    if (valid.indexOf(result) < 0) throw new Error('Unknown result for ' + i.ComponentID + '.');
    if (result === 'Not returned') { stillOut++; return; }
    returned++;
    if (result === 'OK') compPatch[i.ComponentID] = { Status: STATUS.IN_STORE, MaintenanceStatus: MAINT.DUE, CurrentTicket: '', CurrentConveyor: '' };
    if (result === 'Damaged') compPatch[i.ComponentID] = { Status: STATUS.IN_STORE, Condition: CONDITION.DAMAGED, MaintenanceStatus: MAINT.DUE, CurrentTicket: '', CurrentConveyor: '', Remarks: res.remarks || 'Damaged on ' + tk.TicketNo };
    if (result === 'Missing') compPatch[i.ComponentID] = { Status: STATUS.MISSING, CurrentConveyor: '', Remarks: 'Missing on return of ' + tk.TicketNo };
    if (result !== 'OK') problems.push({ id: i.ComponentID, name: i.ComponentName, result: result, remarks: res.remarks || '' });
    results[i.ComponentID].row = { QtyIn: result === 'Missing' ? 0 : i.QtyOut, ConditionIn: result, ReturnedOn: now, Remarks: res.remarks || '' };
  });
  if (!returned) throw new Error('Mark at least one component as returned (OK, Damaged or Missing).');
  if (problems.length && !String(d.issueText || '').trim()) throw new Error('Describe the damaged or missing parts for the FM team.');

  updateMany('Components', 'ComponentID', compPatch);
  updateRows('TicketItems', function (o) {
    return o.TicketNo === tk.TicketNo && results[o.ComponentID] && results[o.ComponentID].row ? results[o.ComponentID].row : null;
  });
  var r = findOne('Requests', 'RequestNo', tk.RequestNo);
  var status, issueNo = '';
  if (problems.length) {
    issueNo = nextNumber('issue', 'ISS');
    appendRow('Issues', { IssueNo: issueNo, TicketNo: tk.TicketNo, RaisedBy: admin.UserID, RaisedOn: now, Description: d.issueText,
                          AffectedComponents: JSON.stringify(problems), Status: 'Open' });
    status = TKT.ISSUE;
    queueMail('HEATER_ISSUE', tk.TicketNo, contacts_(r), getSetting('OverdueCC', ''), 'Ticket ' + tk.TicketNo + ': damaged or missing heater parts (' + issueNo + ')',
      mailHtml_('Ticket ' + tk.TicketNo + ' has an issue', [['Conveyor', tk.ConveyorName], ['Vendor team', r.VendorTeam], ['Issue', d.issueText]]
        .concat(problems.map(function (p) { return [p.id + ' ' + p.name, p.result + (p.remarks ? ': ' + p.remarks : '')]; })),
        'The following heater parts were returned damaged or are missing. Kindly give an explanation: log in to the app, open ticket ' + tk.TicketNo +
        ', and write what happened and the action you will take. The ticket stays open until the RTG Store accepts it.'));
  } else {
    var openIssue = readTable('Issues').some(function (i) { return i.TicketNo === tk.TicketNo && i.Status !== 'Closed'; });
    status = openIssue ? TKT.ISSUE : stillOut ? TKT.PARTLY : TKT.CLOSED;
  }
  var patch = { Status: status, ReturnedOn: stillOut ? '' : now };
  if (status === TKT.CLOSED) { patch.ClosedBy = admin.UserID; patch.ClosedOn = now; }
  updateWhere('Tickets', 'TicketNo', tk.TicketNo, patch);
  if (!stillOut) {
    // Everything is back, so any move still waiting for approval no longer applies.
    updateRows('TransferRequests', function (x) {
      return x.TicketNo === tk.TicketNo && ['Approved', 'Rejected', 'Cancelled'].indexOf(x.Status) < 0 ? { Status: 'Cancelled' } : null;
    });
  }
  audit(admin.UserID, 'returnTicket', tk.TicketNo, { returned: returned, stillOut: stillOut, problems: problems.length });
  if (status === TKT.CLOSED) {
    queueMail('TICKET_CLOSED', tk.TicketNo, contacts_(r), '', 'Ticket ' + tk.TicketNo + ' closed',
      mailHtml_('Ticket ' + tk.TicketNo + ' is closed', [['Conveyor', tk.ConveyorName]], 'All components were returned and inspected OK. Thank you.'));
  }
  return { status: status, issueNo: issueNo, stillOut: stillOut };
}

// FM (whoever raised the request, anyone in the FM team, or an admin) may hand back and explain.
function canActForFM_(user, req) {
  return user.Role === 'Admin' || user.Team === 'FM' || (req && req.RaisedBy === user.UserID);
}

// FM says which parts they have handed back to the store. RTG then inspects them (returnTicket).
function declareReturn(user, d) {
  var tk = findOne('Tickets', 'TicketNo', d.TicketNo);
  if (!tk) throw new Error('No such ticket.');
  var r = findOne('Requests', 'RequestNo', tk.RequestNo) || {};
  if (!canActForFM_(user, r)) throw new Error('Only the FM team can return this heater.');
  if (OPEN_TICKET.indexOf(tk.Status) < 0) throw new Error('This ticket is ' + tk.Status.toLowerCase() + ', nothing to return.');
  var ids = parseList_(d.ComponentIDs);
  var items = readTable('TicketItems').filter(function (i) { return i.TicketNo === tk.TicketNo && !i.ConditionIn && !i.ReturnDeclaredOn && ids.indexOf(i.ComponentID) >= 0; });
  if (!items.length) throw new Error('Choose at least one component you are handing back.');
  var now = new Date(), chosen = {};
  items.forEach(function (i) { chosen[i.ComponentID] = true; });
  updateRows('TicketItems', function (o) { return o.TicketNo === tk.TicketNo && chosen[o.ComponentID] ? { ReturnDeclaredOn: now } : null; });
  updateWhere('Tickets', 'TicketNo', tk.TicketNo, { ReturnRequestedBy: user.UserID, ReturnRequestedOn: now, ReturnNote: d.note || '' });
  var left = readTable('TicketItems').filter(function (i) { return i.TicketNo === tk.TicketNo && !i.ConditionIn && !i.ReturnDeclaredOn; }).length;
  queueMail('RETURN_DECLARED', tk.TicketNo, getSetting('RTGTeamMail', ''), '', 'Heater returned on ticket ' + tk.TicketNo + ': please inspect',
    mailHtml_('FM has returned heater parts on ticket ' + tk.TicketNo, [['Conveyor', tk.ConveyorName], ['Returned by', user.Name], ['Note', d.note || '']]
      .concat(itemsTable_(items)).concat(left ? [['Still on site', left + ' component(s)']] : []),
      'Please inspect the parts in the app and mark anything damaged or missing.'));
  audit(user.UserID, 'declareReturn', tk.TicketNo, { items: items.length });
  return { declared: items.length, stillOnSite: left };
}

// FM answers an issue: what happened and what they will do. RTG then accepts it and closes.
function explainIssue(user, d) {
  var iss = findOne('Issues', 'IssueNo', d.IssueNo);
  if (!iss) throw new Error('No such issue.');
  var tk = findOne('Tickets', 'TicketNo', iss.TicketNo) || {};
  var r = findOne('Requests', 'RequestNo', tk.RequestNo) || {};
  if (!canActForFM_(user, r)) throw new Error('Only the FM team can explain this issue.');
  if (iss.Status === 'Closed') throw new Error('This issue is already closed.');
  required_(d, [['explanation', 'Explanation'], ['actionPlan', 'Action you will take']]);
  var now = new Date();
  updateWhere('Issues', 'IssueNo', iss.IssueNo, { FMExplanation: d.explanation, FMActionPlan: d.actionPlan, ExplainedBy: user.UserID, ExplainedOn: now, Status: 'Explained' });
  var raiser = findOne('Users', 'UserID', iss.RaisedBy);
  queueMail('ISSUE_EXPLAINED', iss.IssueNo, [getSetting('RTGTeamMail', ''), raiser && raiser.Email].filter(String).join(','), contacts_(r),
    'FM explanation for ' + iss.IssueNo + ' on ticket ' + iss.TicketNo,
    mailHtml_('FM has explained issue ' + iss.IssueNo, [['Ticket', iss.TicketNo], ['Issue', iss.Description], ['Explained by', user.Name],
      ['What happened', d.explanation], ['Action they will take', d.actionPlan]], 'Please review it in the app and close the ticket if you accept it.'));
  audit(user.UserID, 'explainIssue', iss.IssueNo);
  return { status: 'Explained' };
}

// Admin accepts the FM explanation and closes the issue (and the ticket, if nothing is still on site).
// If FM explained outside the app, the admin can type it in instead.
function closeIssue(admin, d) {
  var iss = findOne('Issues', 'IssueNo', d.IssueNo);
  if (!iss) throw new Error('No such issue.');
  if (iss.Status === 'Closed') throw new Error('This issue is already closed.');
  var patch = { Status: 'Closed', ClosedBy: admin.UserID, ClosedOn: new Date(), ClosingRemark: d.remark || '' };
  if (!iss.FMExplanation) {
    if (!String(d.explanation || '').trim()) throw new Error('FM has not explained yet. Wait for their explanation, or type in what they told you.');
    patch.FMExplanation = d.explanation;
  }
  var now = patch.ClosedOn;
  updateWhere('Issues', 'IssueNo', iss.IssueNo, patch);
  var openIssues = readTable('Issues').filter(function (i) { return i.TicketNo === iss.TicketNo && i.Status !== 'Closed'; }).length;
  var stillOut = readTable('TicketItems').filter(function (i) { return i.TicketNo === iss.TicketNo && !i.ConditionIn; }).length;
  var status = openIssues ? TKT.ISSUE : stillOut ? TKT.PARTLY : TKT.CLOSED;
  var tpatch = { Status: status };
  if (status === TKT.CLOSED) { tpatch.ClosedBy = admin.UserID; tpatch.ClosedOn = now; }
  updateWhere('Tickets', 'TicketNo', iss.TicketNo, tpatch);
  if (status === TKT.CLOSED) {
    var tk = findOne('Tickets', 'TicketNo', iss.TicketNo) || {};
    var r = findOne('Requests', 'RequestNo', tk.RequestNo) || {};
    queueMail('TICKET_CLOSED', iss.TicketNo, contacts_(r), '', 'Ticket ' + iss.TicketNo + ' closed',
      mailHtml_('Ticket ' + iss.TicketNo + ' is closed', [['Issue', iss.IssueNo], ['RTG remark', d.remark || '']], 'The RTG Store accepted the explanation and closed the ticket.'));
  }
  audit(admin.UserID, 'closeIssue', iss.IssueNo);
  return { status: status };
}

// ---------- maintenance ----------
// After every joint the parts come back "maintenance due". This puts them back into service.
function completeMaintenance(admin, d) {
  var ids = parseList_(d.ComponentIDs);
  if (!ids.length) throw new Error('Choose at least one component.');
  var comps = {};
  readTable('Components').forEach(function (c) { comps[c.ComponentID] = c; });
  var patches = {};
  ids.forEach(function (id) {
    var c = comps[id];
    if (!c) throw new Error('Unknown component ' + id + '.');
    if (c.Status !== STATUS.IN_STORE) throw new Error(id + ' is not in the store.');
    var p = { MaintenanceStatus: MAINT.OK, JointsSinceMaintenance: 0, LastInspected: today() };
    if (d.repaired && c.Condition !== CONDITION.SCRAPPED) p.Condition = CONDITION.OK;
    if (d.scrap) p.Condition = CONDITION.SCRAPPED;
    patches[id] = p;
  });
  updateMany('Components', 'ComponentID', patches);
  audit(admin.UserID, 'maintenance', '', { ids: ids, repaired: !!d.repaired, scrap: !!d.scrap });
  return { updated: ids.length };
}

// Found again after being reported missing.
function markFound(admin, d) {
  var c = findOne('Components', 'ComponentID', d.ComponentID);
  if (!c || c.Status !== STATUS.MISSING) throw new Error('That component is not marked missing.');
  updateWhere('Components', 'ComponentID', c.ComponentID, { Status: STATUS.IN_STORE, MaintenanceStatus: MAINT.DUE, CurrentTicket: '', Remarks: 'Found ' + today() });
  audit(admin.UserID, 'markFound', c.ComponentID);
  return { ok: true };
}

// ---------- dashboard ----------
function dashboard(user) {
  var reqs = listRequests();
  var transfers = user ? listTransfers(user) : [];
  function count(fn) { return reqs.filter(fn).length; }
  var comps = readTable('Components'), store = !user || isRtgTeam_(user);
  return {
    pending: count(function (r) { return r.Status === REQ.PENDING; }),
    awaiting: count(function (r) { return r.Status === TKT.AWAITING; }),
    onSite: count(function (r) { return OPEN_TICKET.indexOf(r.Status) >= 0 && r.Status !== TKT.ISSUE; }),
    overdue: count(function (r) { return r.Overdue; }),
    openIssues: readTable('Issues').filter(function (i) { return i.Status !== 'Closed'; }).length,
    maintenanceDue: !store ? 0 : comps.filter(function (c) { return c.Status === STATUS.IN_STORE && c.MaintenanceStatus === MAINT.DUE; }).length,
    missing: !store ? 0 : comps.filter(function (c) { return c.Status === STATUS.MISSING; }).length,
    transfersPending: transfers.filter(function (t) { return t.waitingWith.length; }).length,
    transfersForMe: transfers.filter(function (t) { return t.canDecide; }).length,
    maintenanceToVerify: readTable('MaintenanceLogs').filter(function (l) { return l.Status === 'Submitted'; }).length,
    consumablePending: listConsumableRequests(user).filter(function (r) { return r.Status === 'Pending' || r.Status === 'Approved'; }).length,
    consumableAlerts: !store ? 0 : listConsumables().filter(function (c) { return c.lowStock || c.expiringSoon || c.expiredQty > 0; }).length
  };
}
