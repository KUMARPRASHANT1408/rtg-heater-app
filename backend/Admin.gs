// Admin page for what used to be typed straight into the Sheet: settings, the conveyor and department lists,
// and the activity and mail logs. (On Supabase the Sheet is only a nightly copy, so changes there are overwritten.)

// key: the column that names a row. fixed: rows can't be added or removed, only these columns edited.
var MASTER_TABS = {
  Settings:    { key: 'Key', fixed: ['Value'] },
  Conveyors:   { key: 'ConveyorName', numbers: ['BeltWidth_mm', 'Plies'], rating: 'BeltRating_Nmm' },
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
      if (c === t.rating && v !== '') {
        if (!normRating(v)) return errors.push(where + 'Belt rating "' + v + '" should be a number like 1000, or ST1000 / ST-1600 for a steel-cord belt.');
        v = normRating(v);
        if (/^\d+$/.test(v)) v = Number(v);
      }
      clean[c] = v;
    });
    // A steel-cord belt has no plies.
    if (t.rating && /^ST/.test(String(clean[t.rating] || ''))) clean.Plies = '';
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

// ---------- heater selection guide ----------
// The RTG guide is replaced as a whole. It is read from the guide's own layout: width, rating ("1000/5" or
// "ST1600"; plies may also be a column of their own) and the heater numbers ("12EF, 12GH" or "12-EF").
function apiHeaterGuide() {
  return { rows: readTable('HeaterSelection'), models: readTable('HeaterModels').map(function (m) { return m.ModelID; }) };
}

function heaterId_(v) {
  var t = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  var m = t.match(/^(\d+)-?([A-Z]+)$/);
  return m ? m[1] + '-' + m[2] : t;
}

function apiSaveHeaterGuide(admin, d) {
  var rows = parseList_(d.rows);
  if (!rows.length) throw new Error('The guide is empty.');
  var models = {};
  readTable('HeaterModels').forEach(function (m) { models[String(m.ModelID).toUpperCase()] = m.ModelID; });
  var out = [], errors = [], seen = {};
  rows.forEach(function (r, i) {
    var where = 'Row ' + (i + 2) + ': ';
    var width = Number(String(r.BeltWidth_mm === undefined ? '' : r.BeltWidth_mm).trim());
    var raw = String(r.BeltRating === undefined ? '' : r.BeltRating).toUpperCase().replace(/\s+/g, '');
    var plies = String(r.Plies === undefined ? '' : r.Plies).trim();
    var both = raw.match(/^(\d+)\/(\d+)$/);
    if (both) { raw = both[1]; plies = both[2]; }
    var rating = normRating(raw);
    if (!(width > 0)) return errors.push(where + 'width "' + r.BeltWidth_mm + '" is not a number.');
    if (!rating) return errors.push(where + 'rating "' + r.BeltRating + '" should look like 1000/5, ST1600 or ST-1600.');
    if (/^ST/.test(rating)) plies = '';
    else if (plies !== '' && !(Number(plies) > 0)) return errors.push(where + 'plies "' + plies + '" is not a number.');
    var ids = String(r.HeaterIDs || '').split(/[,;\n]/).map(heaterId_).filter(String);
    if (!ids.length) return errors.push(where + 'no heater numbers.');
    var unknown = ids.filter(function (id) { return !models[id]; });
    if (unknown.length) return errors.push(where + 'heater ' + unknown.join(', ') + ' is not in the heater list. Add it on the Heaters tab first.');
    var k = width + '|' + rating + '|' + plies;
    if (seen[k]) return errors.push(where + width + ' / ' + rating + (plies ? '/' + plies : '') + ' appears twice.');
    seen[k] = true;
    out.push({ BeltWidth_mm: width, BeltRating: rating, Plies: plies === '' ? '' : Number(plies),
               HeaterIDs: ids.map(function (id) { return models[id]; }).join(', '), Notes: String(r.Notes || '').trim() });
  });
  if (errors.length) throw new Error(errors.slice(0, 6).join(' ') + (errors.length > 6 ? ' (' + errors.length + ' problems in all)' : ''));
  var sh = sheet_('HeaterSelection');
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  appendRows('HeaterSelection', out);
  audit(admin.UserID, 'saveHeaterGuide', '', { rows: out.length });
  return { rows: out.length };
}

// ---------- heater list ----------
// Short codes for part IDs, as in the RTG component list (12-G-HP1, 12-G-CB, 12-G-P631...).
// Cross beams and end bolts are counted as one lot; every other part has its own ID.
var PART_CODES = {
  'Heating Platen': 'HP', 'Cross Beam': 'CB', 'Pressure Plate': 'PRP', 'End Bolt & Nut': 'BN', 'Edge Bar': 'EBAR', 'Edge Clamp': 'ECL',
  'Control Panel': 'CP', 'Incoming Cable': 'IC', 'Outgoing Cable': 'OC', 'Distributor Block with Water Pressure Hose': 'DBP',
  'Distributor Block with Water Cooling Hose (Input)': 'DBC', 'Water Pressure Bag': 'WPB', 'Pressure Ply (Wooden)': 'PLY',
  'Water Pump Unit': 'WPU', '63A DS-6 Plug': 'P63', '125A DS-9 Plug': 'P125', 'JB Box': 'JB'
};
var LOT_PARTS = ['Cross Beam', 'End Bolt & Nut'];

function partCode_(name) {
  return PART_CODES[name] || String(name).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(String).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
}

function apiListHeaters() {
  var types = readTable('ComponentTypes'), comps = readTable('Components'), names = [];
  types.forEach(function (t) { if (names.indexOf(t.ComponentName) < 0) names.push(t.ComponentName); });
  Object.keys(PART_CODES).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
  return {
    partNames: names,
    heaters: readTable('HeaterModels').map(function (m) {
      return { ModelID: m.ModelID, ModelName: m.ModelName, MadeFrom: m.MadeFrom,
               parts: types.filter(function (t) { return t.ModelID === m.ModelID; }).map(function (t) { return { name: t.ComponentName, qty: Number(t.QtyPerSet) || 0 }; }),
               rows: comps.filter(function (c) { return c.ModelID === m.ModelID; }).length };
    })
  };
}

// Adds a new (single, not paired) heater with one full set of parts in the store.
function apiAddHeater(admin, d) {
  var id = heaterId_(d.ModelID);
  if (!id) throw new Error('Heater number is required.');
  if (readTable('HeaterModels').some(function (m) { return String(m.ModelID).toUpperCase() === id; })) throw new Error('Heater ' + id + ' already exists.');
  var parts = parseList_(d.parts).map(function (p) { return { name: String(p.name || '').trim(), qty: Number(p.qty) }; }).filter(function (p) { return p.name && p.qty; });
  if (!parts.length) throw new Error('Give the number of each part this heater has.');
  parts.forEach(function (p) { if (!(p.qty > 0) || p.qty % 1) throw new Error('The number for ' + p.name + ' must be a whole number.'); });
  var types = [], comps = [];
  parts.forEach(function (p) {
    var lot = LOT_PARTS.indexOf(p.name) >= 0, code = partCode_(p.name);
    types.push({ ModelID: id, ComponentName: p.name, QtyPerSet: p.qty, IsSerialised: lot ? 'N' : 'Y' });
    var base = { ModelID: id, SetNo: 1, ComponentName: p.name, Condition: CONDITION.OK, Status: STATUS.IN_STORE, MaintenanceStatus: MAINT.OK, JointsSinceMaintenance: 0 };
    if (lot || p.qty === 1) comps.push(Object.assign({}, base, { ComponentID: id + '-' + code, Qty: p.qty }));
    else for (var n = 1; n <= p.qty; n++) comps.push(Object.assign({}, base, { ComponentID: id + '-' + code + n, Qty: 1 }));
  });
  var taken = {};
  readTable('Components').forEach(function (c) { taken[c.ComponentID] = true; });
  comps.forEach(function (c) { if (taken[c.ComponentID]) throw new Error('Part ID ' + c.ComponentID + ' is already used.'); });
  appendRow('HeaterModels', { ModelID: id, ModelName: String(d.ModelName || '').trim() || 'Heater ' + id, Notes: String(d.Notes || '').trim() });
  appendRows('ComponentTypes', types);
  appendRows('Components', comps);
  audit(admin.UserID, 'addHeater', id, { parts: comps.length });
  return { ModelID: id, parts: comps.length };
}

// The newest LOG_LIMIT rows of the activity log or the mail log, newest first.
function apiLog(d) {
  var tab = LOG_TABS.indexOf(d.log) >= 0 ? d.log : 'AuditLog';
  var rows = readTable(tab);
  return { log: tab, columns: SCHEMA[tab], rows: rows.slice(-LOG_LIMIT).reverse(), more: rows.length > LOG_LIMIT };
}
