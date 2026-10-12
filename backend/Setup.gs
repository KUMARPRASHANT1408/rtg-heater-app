// One-time setup. In the Apps Script editor, select `setup` and press Run.
// Safe to run again: it only adds missing tabs, columns and settings.

var DEFAULT_SETTINGS = [
  ['CompanyInbox', '', 'Your company mail address. Power Automate watches it for [RTG-NOTIFY] and export mails.'],
  ['RTGTeamMail', '', 'RTG team address(es) told about new requests (comma separated).'],
  ['OverdueTo', '', 'To list for overdue heater mails (comma separated).'],
  ['OverdueCC', '', 'CC list for overdue heater mails.'],
  ['RejectCC', '', 'CC list for request rejection mails.'],
  ['FMHODMail', '', 'FM HOD mail address. Copied on mails about heater parts not returned or missing (bill remarks).'],
  ['RTGHODMail', '', 'RTG HOD mail address for the same mails. If empty, users with the HOD role are copied.'],
  ['BillMailCC', '', 'Anyone else to copy on the not returned / missing part mails (comma separated).'],
  ['OverdueMailHour', '9', 'Hour of day (0-23) the overdue reminders go out. Run installTriggers() after changing.'],
  ['ExportTime', '18', 'Hour of day (0-23) the Sheet is mailed to CompanyInbox.'],
  ['AppUrl', '', 'GitHub Pages address of the app, used for links in mails.']
];

function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SCHEMA[name];
    var current = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    if (current.join('') === '') {
      sh.getRange(1, 1, 1, head.length).setValues([head]);
    } else {
      // Add any new columns at the end so existing data is never shifted.
      head.forEach(function (h) {
        if (current.indexOf(h) < 0) {
          current.push(h);
          sh.getRange(1, current.length).setValue(h);
        }
      });
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#1f3a68').setFontColor('#ffffff');
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  DEFAULT_SETTINGS.forEach(function (s) {
    if (!findOne('Settings', 'Key', s[0])) appendRow('Settings', { Key: s[0], Value: s[1], Notes: s[2] });
  });

  // Asks for Google Drive permission the first time, and makes the folder for maintenance checklists.
  checklistFolder_();

  var msg = 'Setup complete.';
  if (!readTable('Users').length) {
    var temp = randomPassword();
    var salt = newSalt();
    appendRow('Users', { UserID: 'admin', Name: 'RTG Admin', Role: 'Admin', Team: 'RTG', Salt: salt,
                         PasswordHash: hashPassword(temp, salt), MustChangePassword: true, Active: true, CreatedOn: new Date() });
    msg += ' First login -> user ID: admin, temporary password: ' + temp + ' (you will be asked to change it).';
  }
  Logger.log(msg);
  return msg;
}

// Optional: fill the heater and consumable tabs with SAMPLE rows so the app can be tried before real data arrives.
// Only fills tabs that are empty.
function loadSampleData() {
  Object.keys(SAMPLE_DATA).forEach(function (name) {
    if (!readTable(name).length) appendRows(name, SAMPLE_DATA[name]);
  });
  Logger.log('Sample data loaded into empty tabs.');
}

// Locked out? Select this in the Apps Script editor and press Run. It gives the user "admin"
// a new temporary password (shown in the Execution log) and re-enables the account.
function resetAdminPassword() {
  var temp = randomPassword();
  var salt = newSalt();
  var fields = { Salt: salt, PasswordHash: hashPassword(temp, salt), MustChangePassword: true, Active: true, Role: 'Admin' };
  if (!updateWhere('Users', 'UserID', 'admin', fields)) {
    appendRow('Users', Object.assign({ UserID: 'admin', Name: 'RTG Admin', Team: 'RTG', CreatedOn: new Date() }, fields));
  }
  CacheService.getScriptCache().remove('fail:admin');
  var msg = 'User ID: admin, temporary password: ' + temp + ' (you will be asked to change it).';
  Logger.log(msg);
  return msg;
}

// Run this ONCE before going live, after you have finished testing. It deletes every test request, ticket,
// issue, transfer, consumable request and movement, maintenance log, mail log and audit row, restarts the
// numbers at 0001, removes SAMPLE consumable batches, and puts every heater part back "In store".
// It keeps Users, Settings, HeaterModels, ComponentTypes, Components, Conveyors, Departments and Consumables.
function clearTestData() {
  ['Requests', 'Tickets', 'TicketItems', 'Issues', 'TransferRequests', 'Approvals', 'ConsumableTransactions', 'ConsumableRequests',
   'MaintenanceLogs', 'MailOutbox', 'AuditLog', 'Counters'].forEach(function (name) {
    var sh = sheet_(name);
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  var batches = sheet_('ConsumableBatches'), values = batches.getDataRange().getValues(), col = values[0].indexOf('BatchNo');
  for (var r = values.length - 1; r >= 1; r--) if (String(values[r][col]).indexOf('SAMPLE') === 0) batches.deleteRows(r + 1, 1);
  // Put lots that were split on issue (e.g. 8 of 10 cross beams, row "14-D-CB/HEATER_0001") back into their original row.
  var comps = sheet_('Components'), cv = comps.getDataRange().getValues(), h = cv[0];
  var idCol = h.indexOf('ComponentID'), qtyCol = h.indexOf('Qty'), remCol = h.indexOf('Remarks'), back = {};
  var ids = {};
  for (var j = 1; j < cv.length; j++) ids[String(cv[j][idCol])] = true;
  for (var i = cv.length - 1; i >= 1; i--) {
    // Split rows are named "<lot ID>/<ticket>". Their remark may since say "Missing on return of ...", so go by the ID.
    var id = String(cv[i][idCol]), cut = id.lastIndexOf('/'), base = cut > 0 ? id.slice(0, cut) : '';
    var m = /^Split from (.+)$/.exec(String(cv[i][remCol] || ''));
    if (m || (base && ids[base] && /^[A-Z]+_?\d+$/.test(id.slice(cut + 1)))) {
      base = m ? m[1] : base;
      back[base] = (back[base] || 0) + (Number(cv[i][qtyCol]) || 0);
      comps.deleteRows(i + 1, 1);
    }
  }
  updateRows('Components', function (c) {
    var patch = { Status: STATUS.IN_STORE, Condition: CONDITION.OK, CurrentTicket: '', CurrentConveyor: '', MaintenanceStatus: MAINT.OK,
                  JointsSinceMaintenance: 0, LastInspected: '' };
    if (back[c.ComponentID]) patch.Qty = (Number(c.Qty) || 0) + back[c.ComponentID];
    // Remarks the app wrote during testing (missing, damaged, split) go too; remarks people typed stay.
    if (/^(Missing on return of|Damaged on|Split from) /.test(String(c.Remarks || ''))) patch.Remarks = '';
    return patch;
  });
  Logger.log('Test data cleared. Numbers start again at 0001.');
}
