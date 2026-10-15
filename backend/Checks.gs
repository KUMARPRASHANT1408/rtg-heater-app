// The RTG Vendor checks a heater twice for every ticket: before the store issues it (after RTG approves the request),
// and after FM hands it back. Each check lists the parts with OK / Not OK and a remark. A part leaves the store only
// with the RTG Vendor's OK; an admin may skip that with a reason, which is mailed to the RTG HOD.

var CHECK_STAGE = { BEFORE: 'Before issue', AFTER: 'After return' };

function teamEmails_(team) {
  return readTable('Users').filter(function (u) { return u.Team === team && isActive_(u) && u.Email; })
    .map(function (u) { return u.Email; }).join(',');
}

function parseChecks_(rows) {
  var users = {};
  readTable('Users').forEach(function (u) { users[u.UserID] = u.Name; });
  return rows.map(function (c) {
    return { CheckNo: c.CheckNo, TicketNo: c.TicketNo, Stage: c.Stage, CheckedBy: users[c.CheckedBy] || c.CheckedBy, CheckedOn: c.CheckedOn,
             Result: c.Result, Remarks: c.Remarks, items: parseList_(c.Items) };
  });
}

// Latest result for each part at each stage: {stage: {ComponentID: {ok, remark, CheckNo, CheckedBy, CheckedOn}}}.
function checkStatus_(checks) {
  var out = {};
  out[CHECK_STAGE.BEFORE] = {};
  out[CHECK_STAGE.AFTER] = {};
  checks.forEach(function (c) {
    if (!out[c.Stage]) return;
    c.items.forEach(function (i) {
      out[c.Stage][i.ComponentID] = { ok: !!i.ok, remark: i.remark || '', CheckNo: c.CheckNo, CheckedBy: c.CheckedBy, CheckedOn: c.CheckedOn };
    });
  });
  return out;
}

// Parts back at the store (handed back by FM or already inspected) that have no after-return check yet.
function returnedUnchecked_(items, checked) {
  return items.filter(function (i) { return (i.ReturnDeclaredOn || (i.ConditionIn && i.ConditionIn !== 'Missing')) && !checked[i.ComponentID]; });
}

// Parts that do not have an OK from the RTG Vendor's latest check before issue: [{id, why}].
function notCheckedOk_(ticketNo, ids) {
  var status = checkStatus_(parseChecks_(readTable('HeaterChecks').filter(function (c) { return c.TicketNo === ticketNo; })))[CHECK_STAGE.BEFORE];
  return ids.filter(function (id) { return !(status[id] && status[id].ok); })
    .map(function (id) { return { id: id, why: status[id] ? 'not OK: ' + status[id].remark : 'not checked' }; });
}

// For the requests list and the home page: which tickets wait for an RTG Vendor check.
function ticketsToCheck_() {
  var checks = {}, items = {}, out = {};
  readTable('HeaterChecks').forEach(function (c) { (checks[c.TicketNo] = checks[c.TicketNo] || []).push(c); });
  readTable('TicketItems').forEach(function (i) { (items[i.TicketNo] = items[i.TicketNo] || []).push(i); });
  readTable('Tickets').forEach(function (t) {
    var mine = checks[t.TicketNo] || [];
    if (t.Status === TKT.AWAITING) {
      if (!mine.some(function (c) { return c.Stage === CHECK_STAGE.BEFORE; })) out[t.TicketNo] = CHECK_STAGE.BEFORE;
      return;
    }
    var after = {};
    mine.filter(function (c) { return c.Stage === CHECK_STAGE.AFTER; }).forEach(function (c) { parseList_(c.Items).forEach(function (i) { after[i.ComponentID] = true; }); });
    if (returnedUnchecked_(items[t.TicketNo] || [], after).length) out[t.TicketNo] = CHECK_STAGE.AFTER;
  });
  return out;
}

// d: {TicketNo, Stage, items: [{ComponentID, ok, remark}], Remarks}
function saveHeaterCheck(user, d) {
  if (!canMaintain_(user)) throw new Error('You do not have permission for this.');
  var tk = findOne('Tickets', 'TicketNo', d.TicketNo);
  if (!tk) throw new Error('No such ticket.');
  var stage = d.Stage, allowed = {};
  if (stage === CHECK_STAGE.BEFORE) {
    if (tk.Status !== TKT.AWAITING) throw new Error('This heater is already ' + String(tk.Status).toLowerCase() + '. The check before issue is done while it waits in the store.');
    var r = findOne('Requests', 'RequestNo', tk.RequestNo) || {};
    var from = partModels(readTable('HeaterModels'), r.ModelID || tk.ModelID);
    readTable('Components').forEach(function (c) { if (from.indexOf(c.ModelID) >= 0 && c.Status === STATUS.IN_STORE) allowed[c.ComponentID] = c.ComponentName; });
  } else if (stage === CHECK_STAGE.AFTER) {
    readTable('TicketItems').forEach(function (i) {
      if (i.TicketNo === tk.TicketNo && (i.ReturnDeclaredOn || (i.ConditionIn && i.ConditionIn !== 'Missing'))) allowed[i.ComponentID] = i.ComponentName;
    });
    if (!Object.keys(allowed).length) throw new Error('Nothing on this ticket has come back to the store yet.');
  } else {
    throw new Error('Unknown check.');
  }
  var items = [], seen = {}, bad = 0;
  parseList_(d.items).forEach(function (i) {
    var id = String(i.ComponentID || '');
    if (!(id in allowed)) throw new Error(id + ' is not a part you can check on this ticket now.');
    if (seen[id]) throw new Error(id + ' is listed twice.');
    seen[id] = true;
    var ok = i.ok === true || i.ok === 'true' || i.ok === 'OK', remark = String(i.remark || '').trim().slice(0, 500);
    if (!ok && !remark) throw new Error('Write what is wrong with ' + id + '.');
    if (!ok) bad++;
    items.push({ ComponentID: id, ComponentName: allowed[id], ok: ok, remark: remark });
  });
  if (!items.length) throw new Error('Check at least one part.');
  var no = nextNumber('check', 'VCK');
  var result = bad ? 'Not OK' : 'OK';
  appendRow('HeaterChecks', { CheckNo: no, TicketNo: tk.TicketNo, Stage: stage, CheckedBy: user.UserID, CheckedOn: new Date(), Result: result,
                              Items: JSON.stringify(items), Remarks: String(d.Remarks || '').trim() });
  audit(user.UserID, 'heaterCheck', tk.TicketNo, { stage: stage, parts: items.length, notOk: bad });
  queueMail('HEATER_CHECK', no, getSetting('RTGTeamMail', ''), '', 'RTG Vendor check ' + stage.toLowerCase() + ' on ' + tk.TicketNo + ': ' + result,
    mailHtml_('RTG Vendor checked ticket ' + tk.TicketNo + ' (' + stage.toLowerCase() + ')', [['Checked by', user.Name], ['Result', result], ['Remarks', d.Remarks || '']]
      .concat(items.map(function (i) { return [i.ComponentID + ' ' + i.ComponentName, i.ok ? 'OK' : 'Not OK: ' + i.remark]; })),
      bad ? 'Some parts are not OK. Please look at them before ' + (stage === CHECK_STAGE.BEFORE ? 'issuing the heater.' : 'closing the ticket.') : ''));
  return { CheckNo: no, Result: result };
}
