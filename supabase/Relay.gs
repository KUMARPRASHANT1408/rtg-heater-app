// RTG Heater Management: Supabase relay.
// When the app runs on Supabase, this small script stays in Google for the jobs only Google can do:
//   - sends the app's mails from MailApp to your company inbox (every 5 minutes), as before;
//   - runs the overdue reminders every morning;
//   - every evening copies all Supabase data back into this Google Sheet (a readable backup) and mails the daily export.
// It also does the one-time copy of the Sheet (and the checklist files in Drive) into Supabase.
//
// Paste this as a NEW file named Relay.gs in the same Apps Script project as the app's Code.gs,
// put the function address below, then select connectSupabase and press Run. Full steps: SUPABASE.md.

var SUPABASE_FUNCTION_URL = 'PASTE_FUNCTION_ADDRESS_HERE'; // like https://abcdefgh.supabase.co/functions/v1/rtg

// ---------- run these from the editor ----------

// One time: connects this script, copies all data and checklist files to Supabase, and sets the timers.
function connectSupabase() {
  checkAddress_();
  relayCall_('relayRegister');
  var msg = copyData_(false);
  installRelayTriggers();
  Logger.log(msg + ' Timers set. Now tell Claude it is done, so the app is switched to Supabase.');
}

// Copies the Sheet to Supabase again, REPLACING everything there. Only use this before going live on Supabase.
function copyDataAgain() {
  checkAddress_();
  Logger.log(copyData_(true));
}

// Locked out on Supabase? Gives the user "admin" a new temporary password (shown in the Execution log).
function resetAdminPasswordSupabase() {
  Logger.log(relayCall_('relayResetAdmin').message);
}

// Undo: stop the relay timers and bring back the Google Sheets timers (also point config.js back to Apps Script).
function disconnectSupabase() {
  deleteRelayTriggers_();
  installTriggers();
  Logger.log('Relay timers removed and the Google Sheets timers are back.');
}

// ---------- timers ----------

function installRelayTriggers() {
  deleteRelayTriggers_();
  ScriptApp.newTrigger('relayMailTick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('relayOverdue').timeBased().everyDays(1).atHour(Number(getSetting('OverdueMailHour', 9))).create();
  ScriptApp.newTrigger('relayNightly').timeBased().everyDays(1).atHour(Number(getSetting('ExportTime', 18))).create();
}

function deleteRelayTriggers_() {
  var mine = ['dailyJobs', 'dailyExport', 'relayMailTick', 'relayOverdue', 'relayNightly'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
}

// Every 5 minutes: send the mails the app has queued. A mail that fails because of the daily limit stays queued.
function relayMailTick() {
  var list = relayCall_('relayMail');
  if (!list.length) return;
  var done = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i].mail;
    var opts = { to: m.to, subject: m.subject, body: m.body || ' ' };
    if (m.cc) opts.cc = m.cc;
    if (m.htmlBody) opts.htmlBody = m.htmlBody;
    var files = (m.attachments || []).map(function (a) {
      return a.b64 !== undefined && a.b64 !== null
        ? Utilities.newBlob(Utilities.base64Decode(a.b64), a.type, a.name)
        : Utilities.newBlob(a.text || '', a.type, a.name);
    });
    if (files.length) opts.attachments = files;
    try {
      MailApp.sendEmail(opts);
    } catch (err) {
      if (/too many times|limit/i.test(err.message)) break; // daily mail limit: try again later
      Logger.log('Mail skipped (' + m.subject + '): ' + err.message);
    }
    done.push(list[i].id);
  }
  if (done.length) relayCall_('relayMailDone', { ids: done });
}

function relayOverdue() {
  var res = relayCall_('relayDaily');
  Logger.log(res.overdueMails + ' overdue mail(s) queued.');
  relayMailTick();
}

function relayNightly() {
  mirrorFromSupabase();
  if (getSetting('CompanyInbox', '')) dailyExport();
}

// Writes every Supabase tab into this Sheet, so the Sheet is always a full, readable copy of the app's data.
function mirrorFromSupabase() {
  var data = relayCall_('relayExport');
  var ss = SpreadsheetApp.getActive();
  data.order.forEach(function (name) {
    var rows = data.tabs[name].map(function (r) {
      return r.map(function (v) { return v && typeof v === 'object' && v.$d ? new Date(v.$d) : v; });
    });
    var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 1);
    rows = rows.map(function (r) { while (r.length < width) r.push(''); return r; });
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clearContents();
    sh.getRange(1, 1, rows.length, width).setValues(rows);
  });
  SpreadsheetApp.flush();
  Logger.log('Sheet updated from Supabase.');
}

// ---------- helpers ----------

function copyData_(replace) {
  var ss = SpreadsheetApp.getActive();
  var order = [], tabs = {};
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    order.push(name);
    tabs[name] = sh.getDataRange().getValues().map(function (r) { return r.map(cell_); });
  });
  var res = relayCall_('relayImport', { order: order, tabs: tabs, replace: replace });
  var files = 0, failed = 0;
  readTable('MaintenanceLogs').forEach(function (l) {
    if (!l.ChecklistFileId) return;
    try {
      var blob = DriveApp.getFileById(l.ChecklistFileId).getBlob();
      relayCall_('relayFile', { id: l.ChecklistFileId, type: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) });
      files++;
    } catch (err) {
      failed++;
      Logger.log('Checklist of ' + l.LogNo + ' not copied: ' + err.message);
    }
  });
  return 'Copied ' + order.length + ' tabs and ' + files + ' checklist file(s) to Supabase' + (failed ? ' (' + failed + ' failed, see above)' : '') +
    '. ' + res.message;
}

function checkAddress_() {
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/rtg$/.test(SUPABASE_FUNCTION_URL)) {
    throw new Error('Put your function address in SUPABASE_FUNCTION_URL at the top of Relay.gs first (like https://abcdefgh.supabase.co/functions/v1/rtg).');
  }
}

// The relay's own password, made once and kept in this script's properties. Supabase remembers the first one it sees.
function relayKey_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('RTG_RELAY_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('RTG_RELAY_KEY', key);
  }
  return key;
}

function relayCall_(action, data) {
  var res = UrlFetchApp.fetch(SUPABASE_FUNCTION_URL, {
    method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
    payload: JSON.stringify({ action: action, key: relayKey_(), data: data || {} })
  });
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error('Supabase answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  if (!body.ok) throw new Error(body.error);
  return body.data;
}
