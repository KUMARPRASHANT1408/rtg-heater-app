// GENERATED copy of shared/logic.js. Edit the shared file and run tools/build.py.
// Shared business rules. This exact file runs in Apps Script (copied to backend/Logic.gs)
// and in the browser (demo mode), so it must stay plain ES5-style functions with no imports.

var STATUS = { IN_STORE: 'In store', ISSUED: 'Issued', MISSING: 'Missing' };
var CONDITION = { OK: 'OK', DAMAGED: 'Damaged', REPAIR: 'Under repair', SCRAPPED: 'Scrapped' };
var MAINT = { OK: 'OK', DUE: 'Due' };
// Remarks written by themselves on a return when a part is not back or is missing. The vendor's bill depends on them.
var BILL_REMARK = {
  'Not returned': 'Bills to be approved only after returning the component.',
  'Missing': 'Bills to be approved after consulting RTG, and the spare cost is to be deducted from the vendor bill. Before approving the bill, kindly share the amount deducted.'
};

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

// Belt ratings: a fabric belt is a plain number (1000) and has plies; a steel-cord belt starts with ST and has no plies.
// RTG writes some steel-cord belts as "ST-1600" to tell them apart from "ST1600" (different heaters), so a
// steel-cord rating is a code that must match exactly. Returns the cleaned text, or '' when it is not a rating.
function normRating(v) {
  var t = String(v === undefined || v === null ? '' : v).toUpperCase().replace(/\s+/g, '');
  return /^\d+$/.test(t) || /^ST-?\d+$/.test(t) ? t : '';
}
function isSteelCord_(v) { return /^\s*st/i.test(String(v === undefined ? '' : v)); }

// Rows of the RTG selection guide that cover this belt: same width, then for a steel-cord belt the same ST code,
// and for a fabric belt the same rating among the fabric rows, with the same plies when both are given.
function guideMatches(guide, width, rating, plies) {
  var st = isSteelCord_(rating), code = normRating(rating) || String(rating).toUpperCase().replace(/\s+/g, ''), r = ratingNum_(rating);
  return guide.filter(function (g) {
    if (num_(g.BeltWidth_mm) !== width) return false;
    if (st) return isSteelCord_(g.BeltRating) && String(g.BeltRating).toUpperCase().replace(/\s+/g, '') === code;
    if (isSteelCord_(g.BeltRating) || ratingNum_(g.BeltRating) !== r) return false;
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

// ---------- joint calculator ----------
// Numbers below are the RTG standard Prashant supplied on 2026-10-10 (DIN 22102 / ISO practice for fabric belts,
// DIN 22131 for steel cord). Change them here if the standard changes.
var JOINT_STD = {
  // Step length by the rating of ONE ply (belt rating / plies). step: [low, high] of the recommended range.
  steps: [
    { from: 100, to: 125, step: [200, 200], overlap: 150, label: 'EP 100 – EP 125' },
    { from: 160, to: 200, step: [250, 250], overlap: 200, label: 'EP 160 – EP 200' },
    { from: 250, to: 315, step: [300, 350], overlap: 250, label: 'EP 250 – EP 315' },
    { from: 400, to: 500, step: [400, 400], overlap: 350, label: 'EP 400 – EP 500' },
    { from: 630, to: 630, step: [450, 500], overlap: 400, label: 'EP 630' }
  ],
  minStep: 200, ruleOfThumb: 0.25,          // step >= 0.25 x ply rating, never under 200 mm
  biasDeg: 16.7,                            // bias length = width x tan(angle); 16.7 deg gives 300 mm on a 1000 mm belt
  edgeMargin: [75, 100],                    // platen overhang each side of the belt
  endClear: [100, 150],                     // rhombic platen overhang at each end of the steps (100 used)
  platenModule: 500,                        // rhombic platens come in 500 mm sections
  rectEndClear: [100, 150],                 // rectangular platen overhang at each end of the full splice
  pressure: [0.8, 1.0],                     // MPa, fabric belts (0.7 - 1.0 allowed, 0.8 recommended)
  beamRating_t: 30,                         // each crossbeam station rated for at least 30 t
  carcassPerPly: 1.125,                     // mm, estimate when the carcass thickness is not measured (4 plies = 4.5 mm)
  soak: { base: 30, perMm: 3.15, fromMm: 9.5 }, // soak minutes = 30 + 3.15 x (T - 9.5 mm), rounded up
  cureTemp: 145, startTimerAt: 142, maxTemp: 150, releaseAt: 60, bumpAt: 100,
  seatPressure: 2.5, fullPressure: [8, 10],  // bar
  rampUp: [35, 45],                         // minutes, ambient to 145 C
  cooling: { water: [15, 25], air: [35, 50], natural: [60, 90] },
  steel: [
    { from: 500, to: 2000, steps: 1, splice: [800, 1300] },
    { from: 2500, to: 3150, steps: 2, splice: [1500, 2100] },
    { from: 3500, to: 4500, steps: 3, splice: [2500, 3300] },
    { from: 5000, to: 5400, steps: 4, splice: [3600, 4200] }
  ]
};

// "EP 800/4", "ep800/4", "NN 630 / 3", "ST1000" -> {type, rating, plies}
function parseBelt(spec) {
  var m = String(spec || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,3})?-?(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  return { type: m[1] || 'EP', rating: Number(m[2]), plies: m[3] ? Number(m[3]) : 0 };
}

function ceil10_(x) { return Math.ceil(x / 10 - 1e-9) * 10; }

// Step length for one ply rating. Inside a band with a range (EP 250 - 315 -> 300 - 350 mm) the value is
// interpolated and rounded up to 10 mm; between two bands the next higher band is used.
function stepFor(plyRating) {
  var t = JOINT_STD.steps, notes = [], band = null, step;
  for (var i = 0; i < t.length; i++) {
    if (plyRating <= t[i].to) { band = t[i]; break; }
  }
  if (!band) {
    // Never shorter than the strongest band in the table.
    step = Math.max(JOINT_STD.minStep, ceil10_(JOINT_STD.ruleOfThumb * plyRating), t[t.length - 1].step[1]);
    notes.push('Ply rating ' + plyRating + ' N/mm is above the standard table (EP 630), so the longer of the EP 630 step and the rule of thumb (0.25 x ply rating) is used. Check the belt maker\'s datasheet.');
    return { step: step, range: [step, step], overlap: null, band: 'Rule of thumb', notes: notes };
  }
  if (plyRating < band.from) notes.push(plyRating < t[0].from ? 'Ply rating ' + plyRating + ' N/mm is below the table; the lowest band is used.' : 'Ply rating ' + plyRating + ' N/mm falls between two bands of the table; the next higher band (' + band.label + ') is used.');
  var lo = band.step[0], hi = band.step[1];
  if (lo === hi) step = lo;
  else if (band.from === band.to || plyRating >= band.to) step = hi;
  else if (plyRating <= band.from) step = lo;
  else step = ceil10_(lo + (hi - lo) * (plyRating - band.from) / (band.to - band.from));
  step = Math.max(step, JOINT_STD.minStep, ceil10_(JOINT_STD.ruleOfThumb * plyRating));
  return { step: step, range: [lo, hi], overlap: band.overlap, band: band.label, notes: notes };
}

function round_(x, d) { var f = Math.pow(10, d || 0); return Math.round(x * f) / f; }

// in: {belt: 'EP 800/4' (or type/rating/plies), width, top, bottom, carcass?, bias?, bevel?, cooling?}
function jointCalc(inp) {
  var b = parseBelt(inp.belt) || {};
  var type = String(inp.type || b.type || 'EP').toUpperCase(), rating = num_(inp.rating) || b.rating, plies = num_(inp.plies) || b.plies;
  var B = num_(inp.width);
  if (!rating) throw new Error('Enter the belt rating, for example EP 800/4 or ST1000.');
  if (!B) throw new Error('Enter the belt width in mm.');
  if (type === 'ST') {
    var band = JOINT_STD.steel.filter(function (s) { return rating >= s.from && rating <= s.to; })[0];
    return { kind: 'steel', type: type, rating: rating, width: B, band: band || null,
             notes: [band ? 'The exact splice length for steel cord belts comes from the cord diameter, cord pitch and the belt maker\'s pull-out test data. The range shown is from the standard.'
                          : 'ST' + rating + ' is not covered by the standard table (ST 500-2000, 2500-3150, 3500-4500, 5000-5400). Use the belt maker\'s splice data.'] };
  }
  if (!plies) throw new Error('Enter the number of plies, for example EP 800/4.');
  var notes = [];
  var plyRating = round_(rating / plies, 1);
  var st = stepFor(plyRating);
  notes = notes.concat(st.notes);
  var steps = plies - 1;
  if (steps < 1) notes.push('A single-ply belt has no steps; this standard is for multi-ply belts.');
  var bevel = num_(inp.bevel), alpha = inp.bias === undefined || inp.bias === '' ? JOINT_STD.biasDeg : num_(inp.bias);
  var Lv = steps * st.step;
  var lb = Math.round(B * Math.tan(alpha * Math.PI / 180));
  var Ltot = Lv + 2 * bevel + lb;

  var W = [B + 2 * JOINT_STD.edgeMargin[0], B + 2 * JOINT_STD.edgeMargin[1]];
  var rhMin = Lv + 2 * JOINT_STD.endClear[0];
  var rh = { required: rhMin, length: Math.ceil(rhMin / JOINT_STD.platenModule) * JOINT_STD.platenModule, range: [rhMin, Lv + 2 * JOINT_STD.endClear[1]] };
  rh.sections = rh.length / JOINT_STD.platenModule;
  var re = { length: Ltot + 2 * JOINT_STD.rectEndClear[0], range: [Ltot + 2 * JOINT_STD.rectEndClear[0], Ltot + 2 * JOINT_STD.rectEndClear[1]] };
  function force(Lp) {
    var A = (Lp / 1000) * (W[0] / 1000);
    var kN = JOINT_STD.pressure.map(function (P) { return Math.round(P * A * 1000); });
    var t = kN.map(function (k) { return Math.round(k / 9.80665); });
    return { area: round_(A, 3), kN: kN, t: t, beams: Math.ceil(kN[1] / 9.80665 / JOINT_STD.beamRating_t) };
  }
  rh.force = force(rh.length); re.force = force(re.length);

  var measured = num_(inp.carcass) > 0;
  var carcass = measured ? num_(inp.carcass) : round_(plies * JOINT_STD.carcassPerPly, 2);
  var top = num_(inp.top), bottom = num_(inp.bottom), T = round_(carcass + top + bottom, 2), cure = null;
  if (!top && !bottom) notes.push('Enter the top and bottom cover thickness to get the cure time.');
  else {
    var S = JOINT_STD.soak, soakMin = Math.max(1, Math.ceil(S.base + S.perMm * (T - S.fromMm) - 1e-9));
    var cool = JOINT_STD.cooling[inp.cooling] || JOINT_STD.cooling.water;
    cure = { thickness: T, carcass: carcass, carcassEstimated: !measured, top: top, bottom: bottom, soakUsed: soakMin,
             rampUp: JOINT_STD.rampUp, cooling: inp.cooling && JOINT_STD.cooling[inp.cooling] ? inp.cooling : 'water', cool: cool,
             total: [JOINT_STD.rampUp[0] + soakMin + cool[0], JOINT_STD.rampUp[1] + soakMin + cool[1]] };
  }
  return {
    kind: 'fabric', type: type, rating: rating, plies: plies, width: B, plyRating: plyRating,
    step: st, steps: steps, bevel: bevel, bias: alpha, overlapLength: Lv, biasLength: lb, totalLength: Ltot,
    platen: { width: W, rhombic: rh, rectangular: re }, pressure: JOINT_STD.pressure, cure: cure, notes: notes
  };
}

// Minute-by-minute press cycle for the simulation chart: heat-up, soak, cool-down under pressure.
// o: {ambient (C), rate (C per min), pressure (bar), coolMin}. Returns {points: [{t, temp, bar, phase}], marks}.
function cureProfile(cure, o) {
  var S = JOINT_STD, amb = num_(o.ambient) || 30, rate = num_(o.rate) || 3, full = num_(o.pressure) || S.fullPressure[0];
  var cool = num_(o.coolMin) || (cure.cool[0] + cure.cool[1]) / 2;
  var ramp = Math.max(1, Math.ceil((S.cureTemp - amb) / rate)), soak = cure.soakUsed, pts = [], t;
  var bumpT = Math.max(0, (S.bumpAt - amb) / rate);
  for (t = 0; t <= ramp; t++) {
    var temp = Math.min(S.cureTemp, amb + rate * t);
    // Seat at low pressure; raise to full pressure over the 100 - 110 C band.
    var bar = temp < S.bumpAt ? S.seatPressure : Math.min(full, S.seatPressure + (full - S.seatPressure) * (temp - S.bumpAt) / 10);
    pts.push({ t: t, temp: Math.round(temp), bar: round_(bar, 1), phase: 'Heat-up' });
  }
  for (t = ramp + 1; t <= ramp + soak; t++) pts.push({ t: t, temp: S.cureTemp, bar: full, phase: 'Soak' });
  var c0 = ramp + soak;
  for (t = c0 + 1; t <= c0 + cool; t++) {
    pts.push({ t: t, temp: Math.round(S.cureTemp - (S.cureTemp - S.releaseAt) * (t - c0) / cool), bar: full, phase: 'Cool-down' });
  }
  var end = c0 + Math.ceil(cool);
  pts.push({ t: end + 1, temp: S.releaseAt, bar: 0, phase: 'Released' });
  return { points: pts, marks: { bump: Math.round(bumpT), soakStart: ramp, coolStart: c0, release: end }, ramp: ramp, soak: soak, cool: Math.ceil(cool), total: end };
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
  module.exports = { cureProfile: cureProfile, JOINT_STD: JOINT_STD, parseBelt: parseBelt, stepFor: stepFor, jointCalc: jointCalc, partModels: partModels, guideMatches: guideMatches, normRating: normRating, ratingNum_: ratingNum_, STATUS: STATUS, CONDITION: CONDITION, MAINT: MAINT, BILL_REMARK: BILL_REMARK, isSuitable: isSuitable, isUsable: isUsable, completeSets: completeSets, modelStats: modelStats, heaterSearch: heaterSearch, formatNumber: formatNumber, pickComponents: pickComponents, isOverdue: isOverdue, daysBetween: daysBetween };
}
