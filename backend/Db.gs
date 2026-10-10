// Thin table layer over the Sheet: each tab is a table, row 1 is the header.

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sh;
}

function readTable(name) {
  var values = sheet_(name).getDataRange().getValues();
  var head = values[0];
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    if (values[r].join('') === '') continue;
    var o = {};
    for (var c = 0; c < head.length; c++) o[head[c]] = cell_(values[r][c]);
    rows.push(o);
  }
  return rows;
}

function cell_(v) {
  if (v instanceof Date) {
    var hasTime = v.getHours() || v.getMinutes();
    return Utilities.formatDate(v, Session.getScriptTimeZone(), hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  }
  return v;
}

function today() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function appendRows(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  // Use the tab's real header so a column moved by hand still lines up.
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var rows = objs.map(function (o) {
    return head.map(function (h) { return o[h] === undefined ? '' : o[h]; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
}

function appendRow(name, obj) {
  appendRows(name, [obj]);
}

// Merge `patch` into every row where keyCol === keyVal. Returns the number of rows changed.
function updateWhere(name, keyCol, keyVal, patch) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var head = values[0];
  var k = head.indexOf(keyCol);
  var changed = 0;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][k]) !== String(keyVal)) continue;
    Object.keys(patch).forEach(function (col) {
      var c = head.indexOf(col);
      if (c >= 0) values[r][c] = patch[col];
    });
    sh.getRange(r + 1, 1, 1, head.length).setValues([values[r]]);
    changed++;
  }
  return changed;
}

// One read and one write for many rows: fn(rowObject) returns a patch {col: value} or null.
function updateRows(name, fn) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var head = values[0];
  var changed = 0;
  for (var r = 1; r < values.length; r++) {
    var o = {};
    for (var c = 0; c < head.length; c++) o[head[c]] = cell_(values[r][c]);
    var patch = fn(o);
    if (!patch) continue;
    Object.keys(patch).forEach(function (col) {
      var i = head.indexOf(col);
      if (i >= 0) values[r][i] = patch[col];
    });
    changed++;
  }
  if (changed) sh.getRange(1, 1, values.length, head.length).setValues(values);
  return changed;
}

// patches = {keyValue: {col: value}}
function updateMany(name, keyCol, patches) {
  return updateRows(name, function (o) { return patches[String(o[keyCol])] || null; });
}

function findOne(name, keyCol, keyVal) {
  var rows = readTable(name);
  for (var i = 0; i < rows.length; i++) if (String(rows[i][keyCol]) === String(keyVal)) return rows[i];
  return null;
}

function getSetting(key, fallback) {
  var row = findOne('Settings', 'Key', key);
  return row && row.Value !== '' ? row.Value : fallback;
}

// Next sequential number for a counter. Callers run inside handle()'s script lock, so numbers never repeat.
function nextNumber(counter, prefix) {
  var row = findOne('Counters', 'Name', counter);
  var n = (row ? Number(row.Value) : 0) + 1;
  if (row) updateWhere('Counters', 'Name', counter, { Value: n });
  else appendRow('Counters', { Name: counter, Value: n });
  return formatNumber(prefix, n, 4);
}

function audit(userId, action, ref, details) {
  appendRow('AuditLog', { Time: new Date(), UserID: userId, Action: action, Ref: ref || '', Details: details ? JSON.stringify(details) : '' });
}
