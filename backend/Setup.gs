// One-time setup. In the Apps Script editor, select `setup` and press Run.
// Safe to run again: it only adds missing tabs, columns and settings.

var DEFAULT_SETTINGS = [
  ['CompanyInbox', '', 'Your company mail address. Power Automate watches it for [RTG-NOTIFY] and export mails.'],
  ['RTGTeamMail', '', 'RTG team address(es) told about new requests (comma separated).'],
  ['OverdueTo', '', 'To list for overdue heater mails (comma separated).'],
  ['OverdueCC', '', 'CC list for overdue heater mails.'],
  ['RejectCC', '', 'CC list for request rejection mails.'],
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
