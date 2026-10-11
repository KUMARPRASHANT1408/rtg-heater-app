// Admin page for what used to be typed straight into the Sheet: settings, the conveyor and department lists,
// and the activity and mail logs. (On Supabase the Sheet is only a nightly copy, so changes there are overwritten.)

// key: the column that names a row. fixed: rows can't be added or removed, only these columns edited.
var MASTER_TABS = {
  Settings:    { key: 'Key', fixed: ['Value'] },
  Conveyors:   { key: 'ConveyorName', numbers: ['BeltWidth_mm', 'BeltRating_Nmm', 'Plies'] },
  Departments: { key: 'Department' }
};
var HIDDEN_SETTINGS = ['ChecklistFolderId'];
var LOG_TABS = ['AuditLog', 'MailOutbox'];
var LOG_LIMIT = 300;

function masterTab_(tab) {
  var t = MASTER_TABS[tab];
  if (!t) throw new Error('This list cannot be edited here.');
  return t;
}

function apiMasterList(d) {
  var t = masterTab_(d.tab);
  var rows = readTable(d.tab);
  if (d.tab === 'Settings') rows = rows.filter(function (r) { return HIDDEN_SETTINGS.indexOf(r.Key) < 0; });
  return { tab: d.tab, key: t.key, columns: SCHEMA[d.tab], fixed: t.fixed || null, rows: rows };
}

// Adds or updates rows by their key. d.rows: [{col: value}], d.originalKey: set when one row is renamed.
function apiMasterSave(admin, d) {
  var t = masterTab_(d.tab);
  var rows = parseList_(d.rows);
  if (!rows.length) throw new Error('Nothing to save.');
  if (rows.length > 2000) throw new Error('Please save at most 2000 rows at a time.');
  var existing = {};
  readTable(d.tab).forEach(function (r) { existing[String(r[t.key]).toLowerCase()] = r; });
  var seen = {}, adds = [], patches = {}, errors = [];
  rows.forEach(function (r, i) {
    var key = String(r[t.key] === undefined ? '' : r[t.key]).trim();
    var where = rows.length > 1 ? 'Row ' + (i + 1) + ': ' : '';
    if (!key) return errors.push(where + t.key + ' is required.');
    if (seen[key.toLowerCase()]) return errors.push(where + '"' + key + '" appears twice.');
    seen[key.toLowerCase()] = true;
    var clean = {};
    SCHEMA[d.tab].forEach(function (c) {
      if (r[c] === undefined || (t.fixed && t.fixed.indexOf(c) < 0)) return;
      var v = String(r[c]).trim();
      if (t.numbers && t.numbers.indexOf(c) >= 0 && v !== '') {
        if (isNaN(Number(v))) return errors.push(where + c + ' must be a number.');
        v = Number(v);
      }
      clean[c] = v;
    });
    var renamedFrom = rows.length === 1 && d.originalKey && String(d.originalKey).toLowerCase() !== key.toLowerCase() ? String(d.originalKey) : '';
    if (renamedFrom && existing[key.toLowerCase()]) return errors.push('"' + key + '" already exists.');
    var old = existing[(renamedFrom || key).toLowerCase()];
    if (old) {
      clean[t.key] = key;
      patches[String(old[t.key])] = clean;
    } else if (t.fixed) {
      errors.push(where + '"' + key + '" is not a setting.');
    } else {
      clean[t.key] = key;
      adds.push(clean);
    }
  });
  if (errors.length) throw new Error(errors.slice(0, 5).join(' ') + (errors.length > 5 ? ' (' + errors.length + ' problems)' : ''));
  if (Object.keys(patches).length) updateMany(d.tab, t.key, patches);
  if (adds.length) appendRows(d.tab, adds);
  audit(admin.UserID, 'saveList', d.tab, { added: adds.length, updated: Object.keys(patches).length, keys: rows.slice(0, 20).map(function (r) { return r[t.key]; }) });
  return { added: adds.length, updated: Object.keys(patches).length };
}

function apiMasterDelete(admin, d) {
  var t = masterTab_(d.tab);
  if (t.fixed) throw new Error('Settings cannot be deleted; clear the value instead.');
  if (!deleteWhere(d.tab, t.key, d.key)) throw new Error('"' + d.key + '" was not found.');
  audit(admin.UserID, 'deleteFromList', d.tab, { key: d.key });
  return { ok: true };
}

// The newest LOG_LIMIT rows of the activity log or the mail log, newest first.
function apiLog(d) {
  var tab = LOG_TABS.indexOf(d.log) >= 0 ? d.log : 'AuditLog';
  var rows = readTable(tab);
  return { log: tab, columns: SCHEMA[tab], rows: rows.slice(-LOG_LIMIT).reverse(), more: rows.length > LOG_LIMIT };
}
