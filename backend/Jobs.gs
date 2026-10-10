// Daily jobs. Run installTriggers() once from the editor; it schedules dailyJobs() every morning
// and the export at Settings.ExportTime.

var EXPORT_TABS = ['Requests', 'Tickets', 'TicketItems', 'Issues', 'TransferRequests', 'Approvals', 'HeaterModels', 'ComponentTypes', 'Components',
                   'Consumables', 'ConsumableBatches', 'ConsumableTransactions', 'ConsumableRequests', 'Conveyors', 'MailOutbox'];

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['dailyJobs', 'dailyExport'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJobs').timeBased().everyDays(1).atHour(Number(getSetting('OverdueMailHour', 9))).create();
  ScriptApp.newTrigger('dailyExport').timeBased().everyDays(1).atHour(Number(getSetting('ExportTime', 18))).create();
  Logger.log('Daily triggers installed.');
}

function dailyJobs() {
  return sendOverdueMails();
}

// One mail per overdue ticket per day, until every component is back and the ticket is closed.
function sendOverdueMails() {
  var t = today();
  var reqs = {};
  readTable('Requests').forEach(function (r) { reqs[r.RequestNo] = r; });
  var outstanding = {};
  readTable('TicketItems').forEach(function (i) { if (!i.ConditionIn) (outstanding[i.TicketNo] = outstanding[i.TicketNo] || []).push(i); });
  var models = {};
  readTable('HeaterModels').forEach(function (m) { models[m.ModelID] = m.ModelName; });
  var to = getSetting('OverdueTo', ''), cc = getSetting('OverdueCC', '');
  var sent = 0, patches = {};
  readTable('Tickets').forEach(function (tk) {
    if ([TKT.ISSUED, TKT.PARTLY, TKT.ISSUE].indexOf(tk.Status) < 0) return;
    if (!outstanding[tk.TicketNo] || !isOverdue(tk.ExpectedReturnDate, t)) return;
    if (String(tk.LastOverdueMail).slice(0, 10) === t) return;
    // FM has handed everything back; it is waiting for RTG inspection, not late on site.
    if (outstanding[tk.TicketNo].every(function (i) { return i.ReturnDeclaredOn; })) return;
    var r = reqs[tk.RequestNo] || {};
    var days = daysBetween(tk.ExpectedReturnDate, t);
    queueMail('OVERDUE', tk.TicketNo, [to, contacts_(r)].filter(String).join(','), cc,
      'OVERDUE: heater ticket ' + tk.TicketNo + ' not returned (' + days + ' day' + (days === 1 ? '' : 's') + ' late)',
      mailHtml_('Heater on ticket ' + tk.TicketNo + ' has not been returned', [
        ['Heater', models[tk.ModelID] || tk.ModelID], ['Conveyor', tk.ConveyorName], ['Vendor team', r.VendorTeam], ['FM representative', r.FMRepresentative],
        ['Was due', tk.ExpectedReturnDate], ['Days overdue', days]].concat(itemsTable_(outstanding[tk.TicketNo])),
        'Please return these components to the RTG Store and close the ticket immediately. This reminder repeats every day until the ticket is closed.'));
    patches[tk.TicketNo] = { LastOverdueMail: t };
    sent++;
  });
  updateMany('Tickets', 'TicketNo', patches);
  Logger.log(sent + ' overdue mail(s) queued.');
  return sent;
}

// Mails an .xlsx copy of the data (no passwords) to CompanyInbox for Power Automate to save in the company folder.
function dailyExport() {
  var inbox = getSetting('CompanyInbox', '');
  if (!inbox) throw new Error('Set CompanyInbox in the Settings tab first.');
  var name = 'RTG-HEATER-EXPORT ' + today();
  var tmp = SpreadsheetApp.create(name);
  try {
    EXPORT_TABS.forEach(function (tab, i) {
      var values = sheet_(tab).getDataRange().getValues();
      var sh = i === 0 ? tmp.getSheets()[0].setName(tab) : tmp.insertSheet(tab);
      sh.getRange(1, 1, values.length, values[0].length).setValues(values);
      sh.setFrozenRows(1);
    });
    var users = readTable('Users').map(function (u) { return [u.UserID, u.Name, u.EmployeeID, u.Email, u.Role, u.Team, u.Department, u.Active]; });
    var us = tmp.insertSheet('Users');
    us.getRange(1, 1, users.length + 1, 8).setValues([['UserID', 'Name', 'EmployeeID', 'Email', 'Role', 'Team', 'Department', 'Active']].concat(users));
    SpreadsheetApp.flush();
    var url = 'https://docs.google.com/spreadsheets/d/' + tmp.getId() + '/export?format=xlsx';
    var blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(name + '.xlsx');
    MailApp.sendEmail({ to: inbox, subject: name, body: 'Daily export from the RTG Heater Store app.', attachments: [blob] });
  } finally {
    DriveApp.getFileById(tmp.getId()).setTrashed(true);
  }
  Logger.log('Export mailed to ' + inbox);
}
