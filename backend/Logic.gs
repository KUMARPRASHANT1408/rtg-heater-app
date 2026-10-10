// GENERATED copy of shared/logic.js. Edit the shared file and run tools/build.py.
// Shared business rules. This exact file runs in Apps Script (copied to backend/Logic.gs)
// and in the browser (demo mode), so it must stay plain ES5-style functions with no imports.

var STATUS = { IN_STORE: 'In store', ISSUED: 'Issued', MISSING: 'Missing' };
var CONDITION = { OK: 'OK', DAMAGED: 'Damaged', REPAIR: 'Under repair', SCRAPPED: 'Scrapped' };
var MAINT = { OK: 'OK', DUE: 'Due' };

function num_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function isSuitable(model, width, rating, plies) {
  var okWidth = width >= num_(model.BeltWidthMin_mm) && width <= num_(model.BeltWidthMax_mm);
  var okRating = !model.RatingMax_Nmm || rating <= num_(model.RatingMax_Nmm);
  var okPlies = !plies || !model.PliesMax || plies <= num_(model.PliesMax);
  return okWidth && okRating && okPlies;
}

function isUsable(c) {
  return c.Status === STATUS.IN_STORE && c.Condition === CONDITION.OK && c.MaintenanceStatus !== MAINT.DUE;
}

// How many complete sets can be built from counts {componentName: qty}.
function completeSets(types, counts) {
  if (!types.length) return 0;
  var sets = Infinity;
  types.forEach(function (t) {
    var per = num_(t.QtyPerSet) || 1;
    sets = Math.min(sets, Math.floor((counts[t.ComponentName] || 0) / per));
  });
  return sets === Infinity ? 0 : sets;
}

function modelStats(model, allTypes, allComponents) {
  var types = allTypes.filter(function (t) { return t.ModelID === model.ModelID; });
  var comps = allComponents.filter(function (c) { return c.ModelID === model.ModelID; });
  var owned = {}, usable = {}, deployments = {};
  comps.forEach(function (c) {
    var q = num_(c.Qty) || 1;
    if (c.Condition !== CONDITION.SCRAPPED) owned[c.ComponentName] = (owned[c.ComponentName] || 0) + q;
    if (isUsable(c)) usable[c.ComponentName] = (usable[c.ComponentName] || 0) + q;
    if (c.Status === STATUS.ISSUED && c.CurrentTicket) {
      var d = deployments[c.CurrentTicket] || (deployments[c.CurrentTicket] = { ticket: c.CurrentTicket, conveyor: c.CurrentConveyor, components: 0 });
      d.components += q;
    }
  });
  var available = completeSets(types, usable);
  // Components that stop one more set being available.
  var shortages = types
    .map(function (t) {
      var per = num_(t.QtyPerSet) || 1;
      return { component: t.ComponentName, have: usable[t.ComponentName] || 0, need: per * (available + 1) };
    })
    .filter(function (s) { return s.have < s.need; });
  var deps = Object.keys(deployments).map(function (k) { return deployments[k]; });
  return {
    model: model,
    totalSets: completeSets(types, owned),
    availableSets: available,
    deployedCount: deps.length,
    deployments: deps,
    shortages: shortages,
    componentList: types.map(function (t) {
      return { name: t.ComponentName, perSet: num_(t.QtyPerSet) || 1, available: usable[t.ComponentName] || 0, serialised: t.IsSerialised === 'Y' };
    })
  };
}

// The heater search screen: suitable models for a belt, plus store-wide totals.
function heaterSearch(data, width, rating, plies) {
  width = num_(width); rating = num_(rating); plies = num_(plies);
  var all = data.models.map(function (m) { return modelStats(m, data.types, data.components); });
  var suitable = all.filter(function (s) { return isSuitable(s.model, width, rating, plies); });
  function sum(list, key) { return list.reduce(function (a, s) { return a + s[key]; }, 0); }
  return {
    query: { width: width, rating: rating, plies: plies },
    totals: {
      heatersInStore: sum(all, 'totalSets'),
      availableAll: sum(all, 'availableSets'),
      suitableTotal: sum(suitable, 'totalSets'),
      suitableAvailable: sum(suitable, 'availableSets'),
      suitableDeployed: sum(suitable, 'deployedCount')
    },
    suitable: suitable,
    deployments: suitable.reduce(function (a, s) {
      return a.concat(s.deployments.map(function (d) { return { model: s.model.ModelName, ticket: d.ticket, conveyor: d.conveyor }; }));
    }, [])
  };
}

// Sequential, zero-padded numbers like RTGH0001 or HEATER_0001.
function formatNumber(prefix, n, width) {
  var s = String(n);
  while (s.length < (width || 4)) s = '0' + s;
  return prefix + s;
}

// Choose physical components for a request. Prefers taking parts from the same set
// (the set with the most usable parts first) so a heater goes out as matched as possible.
// requested: [{name, qty}]. Returns {picks: [{ComponentID, ComponentName, Qty, SetNo, lot}], short: [{name, missing}]}.
function pickComponents(components, modelId, requested) {
  var usable = components.filter(function (c) { return c.ModelID === modelId && isUsable(c); });
  var setScore = {};
  usable.forEach(function (c) { setScore[c.SetNo] = (setScore[c.SetNo] || 0) + 1; });
  usable.sort(function (a, b) {
    return (setScore[b.SetNo] - setScore[a.SetNo]) || (num_(a.SetNo) - num_(b.SetNo)) || String(a.ComponentID).localeCompare(String(b.ComponentID));
  });
  var picks = [], short = [];
  requested.forEach(function (r) {
    var need = num_(r.qty);
    usable.forEach(function (c) {
      if (need <= 0 || c.ComponentName !== r.name || c._taken) return;
      var have = num_(c.Qty) || 1;
      var take = Math.min(have, need);
      c._taken = true;
      picks.push({ ComponentID: c.ComponentID, ComponentName: c.ComponentName, Qty: take, SetNo: c.SetNo, lot: have > 1 });
      need -= take;
    });
    if (need > 0) short.push({ name: r.name, missing: need });
  });
  usable.forEach(function (c) { delete c._taken; });
  return { picks: picks, short: short };
}

// yyyy-MM-dd strings compare correctly as text.
function isOverdue(expectedReturnDate, todayStr) {
  return !!expectedReturnDate && String(expectedReturnDate).slice(0, 10) < todayStr;
}

function daysBetween(fromStr, toStr) {
  var a = new Date(String(fromStr).slice(0, 10) + 'T00:00:00Z'), b = new Date(String(toStr).slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

if (typeof module !== 'undefined') {
  module.exports = { STATUS: STATUS, CONDITION: CONDITION, MAINT: MAINT, isSuitable: isSuitable, isUsable: isUsable, completeSets: completeSets, modelStats: modelStats, heaterSearch: heaterSearch, formatNumber: formatNumber, pickComponents: pickComponents, isOverdue: isOverdue, daysBetween: daysBetween };
}
