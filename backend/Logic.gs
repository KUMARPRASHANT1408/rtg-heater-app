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

// A pair heater (like 14-CD) is built from two single heaters (14-C and 14-D) plus any parts only the pair has.
// HeaterModels.MadeFrom lists the singles. Returns every model ID whose physical parts this heater uses.
function partModels(models, modelId) {
  var m = (models || []).filter(function (x) { return x.ModelID === modelId; })[0];
  return [modelId].concat(m ? splitIds_(m.MadeFrom) : []);
}

// ticketModels (optional) maps TicketNo -> the heater the ticket was for. A pair counts only its own tickets as
// deployed; when a single it is built from is out on its own ticket, that ticket goes in `blockedBy` instead.
// A single that went out inside a pair counts as deployed, with `via` naming the pair.
function modelStats(model, allTypes, allComponents, models, ticketModels) {
  var types = allTypes.filter(function (t) { return t.ModelID === model.ModelID; });
  var from = partModels(models || [model], model.ModelID);
  var comps = allComponents.filter(function (c) { return from.indexOf(c.ModelID) >= 0; });
  var owned = {}, usable = {}, deployments = {}, blocked = {};
  comps.forEach(function (c) {
    var q = num_(c.Qty) || 1;
    if (c.Condition !== CONDITION.SCRAPPED) owned[c.ComponentName] = (owned[c.ComponentName] || 0) + q;
    if (isUsable(c)) usable[c.ComponentName] = (usable[c.ComponentName] || 0) + q;
    if (c.Status !== STATUS.ISSUED || !c.CurrentTicket) return;
    var tm = (ticketModels && ticketModels[c.CurrentTicket]) || c.ModelID;
    var mine = tm === model.ModelID || c.ModelID === model.ModelID;
    var bucket = mine ? deployments : blocked;
    var d = bucket[c.CurrentTicket] || (bucket[c.CurrentTicket] = { ticket: c.CurrentTicket, conveyor: c.CurrentConveyor, components: 0, via: tm === model.ModelID ? '' : tm });
    d.components += q;
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
  var blockedBy = Object.keys(blocked).map(function (k) { return blocked[k]; });
  return {
    model: model,
    madeFrom: from.slice(1),
    blockedBy: blockedBy,
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

// "ST1000" -> 1000. The selection guide writes steel-cord ratings with an ST prefix.
function ratingNum_(v) {
  var m = String(v === undefined ? '' : v).match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}
function splitIds_(v) {
  return String(v || '').split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(String);
}

// Rows of the RTG selection guide that cover this belt: same width, same rating, and same plies when both are given.
// A rating typed as "ST1000" only matches steel-cord rows; a plain number matches either kind.
function isSteelCord_(v) { return /^\s*st/i.test(String(v === undefined ? '' : v)); }
function guideMatches(guide, width, rating, plies) {
  var st = isSteelCord_(rating), r = ratingNum_(rating);
  return guide.filter(function (g) {
    if (num_(g.BeltWidth_mm) !== width || ratingNum_(g.BeltRating) !== r) return false;
    if (st && !isSteelCord_(g.BeltRating)) return false;
    return !plies || !g.Plies || num_(g.Plies) === plies;
  });
}

// The heater search screen: suitable models for a belt, plus store-wide totals.
// When the HeaterSelection tab has rows, it decides which heaters suit a belt (exactly as the RTG guide says).
// Otherwise each model's width/rating range is used.
function heaterSearch(data, width, rating, plies) {
  width = num_(width); plies = num_(plies);
  var ratingText = String(rating === undefined || rating === null ? '' : rating).trim().toUpperCase().replace(/\s+/g, '');
  rating = ratingNum_(ratingText);
  var all = data.models.map(function (m) { return modelStats(m, data.types, data.components, data.models, data.ticketModels); });
  // Pairs reuse their singles' parts, so store-wide totals count single heaters only.
  var physical = all.filter(function (s) { return !s.madeFrom.length; });
  var guide = data.guide || [], suitable, guideInfo = null;
  if (guide.length) {
    var rows = guideMatches(guide, width, ratingText, plies), ids = {};
    rows.forEach(function (g) { splitIds_(g.HeaterIDs).forEach(function (id) { ids[id] = true; }); });
    suitable = all.filter(function (s) { return ids[s.model.ModelID]; });
    guideInfo = {
      matched: rows.map(function (g) { return { rating: g.BeltRating, plies: g.Plies }; }),
      // When nothing matches, what the guide does list for this width, so the user can pick the right rating.
      optionsForWidth: guide.filter(function (g) { return num_(g.BeltWidth_mm) === width; })
        .map(function (g) { return String(g.BeltRating) + (g.Plies ? '/' + g.Plies : ''); }),
      widths: guide.map(function (g) { return num_(g.BeltWidth_mm); }).filter(function (w, i, a) { return a.indexOf(w) === i; }).sort(function (a, b) { return a - b; }),
      unknownIds: Object.keys(ids).filter(function (id) { return !all.some(function (s) { return s.model.ModelID === id; }); })
    };
  } else {
    suitable = all.filter(function (s) { return isSuitable(s.model, width, rating, plies); });
  }
  function sum(list, key) { return list.reduce(function (a, s) { return a + s[key]; }, 0); }
  return {
    query: { width: width, rating: ratingText || rating, plies: plies },
    guide: guideInfo,
    totals: {
      heatersInStore: sum(physical, 'totalSets'),
      availableAll: sum(physical, 'availableSets'),
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
// fromIds: the model IDs whose parts may be used (see partModels); defaults to just modelId.
function pickComponents(components, modelId, requested, fromIds) {
  fromIds = fromIds || [modelId];
  var usable = components.filter(function (c) { return fromIds.indexOf(c.ModelID) >= 0 && isUsable(c); });
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
  module.exports = { partModels: partModels, guideMatches: guideMatches, ratingNum_: ratingNum_, STATUS: STATUS, CONDITION: CONDITION, MAINT: MAINT, isSuitable: isSuitable, isUsable: isUsable, completeSets: completeSets, modelStats: modelStats, heaterSearch: heaterSearch, formatNumber: formatNumber, pickComponents: pickComponents, isOverdue: isOverdue, daysBetween: daysBetween };
}
