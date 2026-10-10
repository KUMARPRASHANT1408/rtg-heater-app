// Consumables: stock by batch and expiry, daily entries, file upload, consumption reports,
// and requests (RTGC0001 -> approve -> CONS_0001 -> issue, which deducts stock).

var TXN = { RECEIPT: 'Receipt', ISSUE: 'Issue', ADJUST: 'Adjustment' };
var EXPIRY_WARN_DAYS = 30;

function num2_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function month_(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

// The last n months as 'yyyy-MM', oldest first, ending with the month of `todayStr`.
function lastMonths_(todayStr, n) {
  var y = Number(todayStr.slice(0, 4)), m = Number(todayStr.slice(5, 7));
  var out = [];
  for (var i = n - 1; i >= 0; i--) {
    var mm = m - i, yy = y;
    while (mm <= 0) { mm += 12; yy--; }
    out.push(yy + '-' + (mm < 10 ? '0' : '') + mm);
  }
  return out;
}

function consumableData_() {
  return { items: readTable('Consumables'), batches: readTable('ConsumableBatches'), txns: readTable('ConsumableTransactions') };
}

function itemSummary_(item, batches, txns, t) {
  var mine = batches.filter(function (b) { return b.ItemID === item.ItemID && num2_(b.Qty) > 0; });
  var stock = mine.reduce(function (a, b) { return a + num2_(b.Qty); }, 0);
  var expired = mine.filter(function (b) { return b.ExpiryDate && String(b.ExpiryDate).slice(0, 10) < t; })
    .reduce(function (a, b) { return a + num2_(b.Qty); }, 0);
  var dated = mine.filter(function (b) { return b.ExpiryDate && String(b.ExpiryDate).slice(0, 10) >= t; })
    .map(function (b) { return String(b.ExpiryDate).slice(0, 10); }).sort();
  var months = lastMonths_(t, 6);
  var issued = txns.filter(function (x) { return x.ItemID === item.ItemID && x.Type === TXN.ISSUE; });
  var last6 = issued.filter(function (x) { return months.indexOf(month_(x.Date)) >= 0; }).reduce(function (a, x) { return a + num2_(x.Qty); }, 0);
  var thisMonth = issued.filter(function (x) { return month_(x.Date) === months[months.length - 1]; }).reduce(function (a, x) { return a + num2_(x.Qty); }, 0);
  var avg = Math.round((last6 / 6) * 10) / 10;
  var nearest = dated[0] || '';
  return {
    ItemID: item.ItemID, ItemName: item.ItemName, Manufacturer: item.Manufacturer, Unit: item.Unit, ReorderLevel: item.ReorderLevel,
    SAPStock: item.SAPStock, SAPStockUpdatedOn: item.SAPStockUpdatedOn,
    stock: stock, usableStock: stock - expired, expiredQty: expired, nearestExpiry: nearest,
    expiringSoon: !!nearest && daysBetween(t, nearest) <= EXPIRY_WARN_DAYS,
    lowStock: item.ReorderLevel !== '' && item.ReorderLevel !== undefined && stock - expired <= num2_(item.ReorderLevel),
    thisMonth: thisMonth, avgMonthly: avg, monthsCover: avg > 0 ? Math.round(((stock - expired) / avg) * 10) / 10 : null
  };
}

function listConsumables() {
  var d = consumableData_(), t = today();
  return d.items.map(function (i) { return itemSummary_(i, d.batches, d.txns, t); });
}

function consumableDetail(d) {
  var data = consumableData_(), t = today();
  var item = data.items.filter(function (i) { return i.ItemID === d.ItemID; })[0];
  if (!item) throw new Error('No such item.');
  var months = lastMonths_(t, 12);
  var issued = data.txns.filter(function (x) { return x.ItemID === item.ItemID && x.Type === TXN.ISSUE && months.indexOf(month_(x.Date)) >= 0; });
  var monthly = months.map(function (m) {
    return { month: m, qty: issued.filter(function (x) { return month_(x.Date) === m; }).reduce(function (a, x) { return a + num2_(x.Qty); }, 0) };
  });
  var depts = {};
  issued.forEach(function (x) { var k = x.Department || 'Not given'; depts[k] = (depts[k] || 0) + num2_(x.Qty); });
  var byDept = Object.keys(depts).map(function (k) { return { department: k, qty: depts[k] }; }).sort(function (a, b) { return b.qty - a.qty; });
  // Department x month table for the last 6 months.
  var m6 = months.slice(-6);
  var deptMonthly = byDept.map(function (dp) {
    return { department: dp.department, months: m6.map(function (m) {
      return issued.filter(function (x) { return (x.Department || 'Not given') === dp.department && month_(x.Date) === m; }).reduce(function (a, x) { return a + num2_(x.Qty); }, 0);
    }) };
  });
  return {
    summary: itemSummary_(item, data.batches, data.txns, t),
    batches: data.batches.filter(function (b) { return b.ItemID === item.ItemID && num2_(b.Qty) > 0; })
      .map(function (b) {
        var exp = String(b.ExpiryDate || '').slice(0, 10);
        return { BatchNo: b.BatchNo, Qty: num2_(b.Qty), ExpiryDate: exp, ReceivedOn: b.ReceivedOn, expired: !!exp && exp < t, daysLeft: exp ? daysBetween(t, exp) : null };
      })
      .sort(function (a, b) { return (a.ExpiryDate || '9999').localeCompare(b.ExpiryDate || '9999'); }),
    monthly: monthly, byDepartment: byDept, deptMonths: m6, deptMonthly: deptMonthly,
    transactions: data.txns.filter(function (x) { return x.ItemID === item.ItemID; }).slice(-50).reverse()
  };
}

function saveConsumable(admin, d) {
  var item = findOne('Consumables', 'ItemID', d.ItemID);
  if (!item) throw new Error('No such item.');
  var patch = {};
  ['Manufacturer', 'Unit', 'ReorderLevel'].forEach(function (k) { if (d[k] !== undefined) patch[k] = d[k]; });
  if (d.SAPStock !== undefined && String(d.SAPStock) !== String(item.SAPStock)) { patch.SAPStock = d.SAPStock; patch.SAPStockUpdatedOn = today(); }
  updateWhere('Consumables', 'ItemID', d.ItemID, patch);
  audit(admin.UserID, 'saveConsumable', d.ItemID, patch);
  return { ok: true };
}

// ---------- stock movements ----------
// Validates one entry against the current batches (mutating `batches` so a list of entries can be checked in order).
// Returns {txns: [...], batchOps: [...]} or throws.
function planEntry_(e, items, batches, user) {
  var item = items.filter(function (i) { return i.ItemID === e.ItemID || String(i.ItemName).toLowerCase() === String(e.ItemName || '').trim().toLowerCase(); })[0];
  if (!item) throw new Error('Unknown item "' + (e.ItemName || e.ItemID || '') + '".');
  var type = String(e.Type || '').trim();
  type = { receipt: TXN.RECEIPT, issue: TXN.ISSUE, adjustment: TXN.ADJUST, adjust: TXN.ADJUST }[type.toLowerCase()] || type;
  if ([TXN.RECEIPT, TXN.ISSUE, TXN.ADJUST].indexOf(type) < 0) throw new Error('Type must be Receipt, Issue or Adjustment.');
  var qty = Number(e.Qty);
  if (isNaN(qty) || qty === 0 || (type !== TXN.ADJUST && qty < 0)) throw new Error('Quantity must be a positive number' + (type === TXN.ADJUST ? ' (or negative to reduce)' : '') + '.');
  var date = String(e.Date || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must look like 2026-10-10.');
  if (date > today()) throw new Error('Date cannot be in the future.');
  var batchNo = String(e.BatchNo || '').trim();
  var base = { Date: date, ItemID: item.ItemID, Type: type, Department: e.Department || '', Conveyor: e.Conveyor || '', Ref: e.Ref || '', EnteredBy: user.UserID };
  var mine = batches.filter(function (b) { return b.ItemID === item.ItemID; });
  var txns = [];

  if (type === TXN.RECEIPT) {
    if (!batchNo) batchNo = 'B' + date.replace(/-/g, '');
    var exp = String(e.ExpiryDate || '').slice(0, 10);
    if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) throw new Error('Expiry date must look like 2027-03-31.');
    var b = mine.filter(function (x) { return String(x.BatchNo) === batchNo; })[0];
    if (b) { b.Qty = num2_(b.Qty) + qty; if (exp) b.ExpiryDate = exp; b._dirty = true; }
    else batches.push({ ItemID: item.ItemID, BatchNo: batchNo, Qty: qty, ExpiryDate: exp, ReceivedOn: date, _new: true });
    txns.push(Object.assign({}, base, { Qty: qty, BatchNo: batchNo }));
  } else if (type === TXN.ISSUE) {
    if (!e.Department) throw new Error('Department is required for an issue.');
    // First expiring first out, skipping expired batches; or the batch named.
    var t = today();
    var pool = batchNo ? mine.filter(function (x) { return String(x.BatchNo) === batchNo; })
      : mine.filter(function (x) { return num2_(x.Qty) > 0 && !(x.ExpiryDate && String(x.ExpiryDate).slice(0, 10) < t); })
          .sort(function (a, c) { return String(a.ExpiryDate || '9999').localeCompare(String(c.ExpiryDate || '9999')); });
    if (batchNo && !pool.length) throw new Error('No batch "' + batchNo + '" for ' + item.ItemName + '.');
    var have = pool.reduce(function (a, x) { return a + num2_(x.Qty); }, 0);
    if (have < qty) throw new Error('Only ' + have + ' ' + (item.Unit || '') + ' of ' + item.ItemName + ' in stock' + (batchNo ? ' in batch ' + batchNo : ' (not expired)') + '.');
    var need = qty;
    pool.forEach(function (x) {
      if (need <= 0) return;
      var take = Math.min(num2_(x.Qty), need);
      if (take <= 0) return;
      x.Qty = num2_(x.Qty) - take; x._dirty = true;
      need -= take;
      txns.push(Object.assign({}, base, { Qty: take, BatchNo: x.BatchNo }));
    });
  } else {
    if (!batchNo) throw new Error('Batch number is required for an adjustment.');
    var bb = mine.filter(function (x) { return String(x.BatchNo) === batchNo; })[0];
    if (!bb) {
      if (qty < 0) throw new Error('No batch "' + batchNo + '" for ' + item.ItemName + '.');
      bb = { ItemID: item.ItemID, BatchNo: batchNo, Qty: 0, ExpiryDate: String(e.ExpiryDate || '').slice(0, 10), ReceivedOn: date, _new: true };
      batches.push(bb);
    }
    if (num2_(bb.Qty) + qty < 0) throw new Error('Batch ' + batchNo + ' has only ' + bb.Qty + '.');
    bb.Qty = num2_(bb.Qty) + qty; bb._dirty = true;
    txns.push(Object.assign({}, base, { Qty: qty, BatchNo: batchNo }));
  }
  var sap = e.SAPStock;
  return { txns: txns, sap: sap !== undefined && sap !== '' ? { ItemID: item.ItemID, SAPStock: Number(sap) } : null };
}

function saveBatches_(batches) {
  var dirty = {};
  batches.forEach(function (b) { if (b._dirty && !b._new) dirty[b.ItemID + '|' + b.BatchNo] = { Qty: b.Qty, ExpiryDate: b.ExpiryDate }; });
  if (Object.keys(dirty).length) updateRows('ConsumableBatches', function (o) { return dirty[o.ItemID + '|' + o.BatchNo] || null; });
  appendRows('ConsumableBatches', batches.filter(function (b) { return b._new; }).map(function (b) {
    return { ItemID: b.ItemID, BatchNo: b.BatchNo, Qty: b.Qty, ExpiryDate: b.ExpiryDate, ReceivedOn: b.ReceivedOn };
  }));
}

// Applies entries all-or-nothing. With dryRun, only validates and returns per-row errors.
function applyEntries_(user, entries, dryRun) {
  var items = readTable('Consumables'), batches = readTable('ConsumableBatches');
  var errors = [], txns = [], saps = {};
  entries.forEach(function (e, i) {
    try {
      var p = planEntry_(e, items, batches, user);
      txns = txns.concat(p.txns);
      if (p.sap) saps[p.sap.ItemID] = p.sap.SAPStock;
    } catch (err) {
      errors.push({ row: i + 1, error: err.message });
    }
  });
  if (errors.length || dryRun) return { ok: !errors.length, errors: errors, rows: entries.length, movements: txns.length };
  saveBatches_(batches);
  appendRows('ConsumableTransactions', txns);
  Object.keys(saps).forEach(function (id) { updateWhere('Consumables', 'ItemID', id, { SAPStock: saps[id], SAPStockUpdatedOn: today() }); });
  return { ok: true, errors: [], rows: entries.length, movements: txns.length };
}

function stockEntry(admin, d) {
  var res = applyEntries_(admin, [d], false);
  if (!res.ok) throw new Error(res.errors[0].error);
  audit(admin.UserID, 'stockEntry', d.ItemID, d);
  return res;
}

function uploadStock(admin, d) {
  var rows = parseList_(d.rows);
  if (!rows.length) throw new Error('The file has no rows.');
  if (rows.length > 2000) throw new Error('Please upload at most 2000 rows at a time.');
  var res = applyEntries_(admin, rows, !!d.dryRun);
  if (!d.dryRun && res.ok) audit(admin.UserID, 'uploadStock', '', { rows: rows.length });
  return res;
}

// ---------- consumable requests ----------
var CREQ = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', ISSUED: 'Issued' };

function raiseConsumableRequest(user, d) {
  required_(d, [['ItemID', 'Material'], ['Qty', 'Quantity'], ['Department', 'Department'], ['Purpose', 'Purpose']]);
  var item = findOne('Consumables', 'ItemID', d.ItemID);
  if (!item) throw new Error('Unknown material.');
  if (!(Number(d.Qty) > 0)) throw new Error('Quantity must be more than 0.');
  var no = nextNumber('crequest', 'RTGC');
  appendRow('ConsumableRequests', { RequestNo: no, RaisedBy: user.UserID, RaisedOn: new Date(), ItemID: item.ItemID, Qty: Number(d.Qty), Department: d.Department,
                                    Conveyor: d.Conveyor || '', Purpose: d.Purpose, Status: CREQ.PENDING });
  audit(user.UserID, 'raiseConsumableRequest', no);
  queueMail('CONSUMABLE_REQUEST', no, getSetting('RTGTeamMail', ''), '', 'New consumable request ' + no + ': ' + item.ItemName,
    mailHtml_('New consumable request ' + no, [['Material', item.ItemName], ['Quantity', d.Qty + ' ' + (item.Unit || '')], ['Department', d.Department],
      ['Conveyor', d.Conveyor || ''], ['Purpose', d.Purpose], ['Raised by', user.Name]], 'Please approve or reject it in the app.'));
  return { RequestNo: no };
}

function listConsumableRequests() {
  var items = {};
  readTable('Consumables').forEach(function (i) { items[i.ItemID] = i; });
  var users = {};
  readTable('Users').forEach(function (u) { users[u.UserID] = u.Name; });
  return readTable('ConsumableRequests').map(function (r) {
    var it = items[r.ItemID] || {};
    return Object.assign({}, r, { ItemName: it.ItemName || r.ItemID, Unit: it.Unit || '', RaisedByName: users[r.RaisedBy] || r.RaisedBy });
  }).reverse();
}

function decideConsumableRequest(admin, d) {
  var r = findOne('ConsumableRequests', 'RequestNo', d.RequestNo);
  if (!r) throw new Error('No such request.');
  if (r.Status !== CREQ.PENDING) throw new Error('This request is already ' + String(r.Status).toLowerCase() + '.');
  var item = findOne('Consumables', 'ItemID', r.ItemID) || {};
  var raiser = findOne('Users', 'UserID', r.RaisedBy);
  var to = raiser && raiser.Email ? raiser.Email : '';
  if (d.decision === 'reject') {
    if (!String(d.reason || '').trim()) throw new Error('Please give a reason for rejecting.');
    updateWhere('ConsumableRequests', 'RequestNo', r.RequestNo, { Status: CREQ.REJECTED, DecidedBy: admin.UserID, DecidedOn: new Date(), RejectReason: d.reason });
    queueMail('CONSUMABLE_REJECTED', r.RequestNo, to, getSetting('RejectCC', ''), 'Consumable request ' + r.RequestNo + ' rejected by RTG team',
      mailHtml_('Request ' + r.RequestNo + ' has been rejected by the RTG team', [['Material', item.ItemName], ['Quantity', r.Qty], ['Reason', d.reason]]));
    audit(admin.UserID, 'rejectConsumableRequest', r.RequestNo);
    return { status: CREQ.REJECTED };
  }
  if (d.decision !== 'approve') throw new Error('Unknown decision.');
  var ticket = nextNumber('cticket', 'CONS_');
  updateWhere('ConsumableRequests', 'RequestNo', r.RequestNo, { Status: CREQ.APPROVED, DecidedBy: admin.UserID, DecidedOn: new Date(), TicketNo: ticket });
  queueMail('CONSUMABLE_APPROVED', r.RequestNo, to, '', 'Consumable request ' + r.RequestNo + ' approved: ticket ' + ticket,
    mailHtml_('Request ' + r.RequestNo + ' is approved. Your ticket number is ' + ticket, [['Material', item.ItemName], ['Quantity', r.Qty + ' ' + (item.Unit || '')]],
      'Bring this ticket number to the RTG Store to collect the material.'));
  audit(admin.UserID, 'approveConsumableRequest', r.RequestNo, { ticket: ticket });
  return { status: CREQ.APPROVED, TicketNo: ticket };
}

// Hands the material over: deducts stock (first expiring first) and records consumption against the department.
function issueConsumable(admin, d) {
  var q = String(d.no || '').trim().toUpperCase();
  var r = readTable('ConsumableRequests').filter(function (x) { return String(x.RequestNo).toUpperCase() === q || String(x.TicketNo).toUpperCase() === q; })[0];
  if (!r) throw new Error('No consumable request or ticket "' + d.no + '".');
  if (r.Status !== CREQ.APPROVED) throw new Error('This request is ' + String(r.Status).toLowerCase() + ', it cannot be issued.');
  var qty = Number(d.Qty || r.Qty);
  var res = applyEntries_(admin, [{ ItemID: r.ItemID, Type: TXN.ISSUE, Qty: qty, BatchNo: d.BatchNo || '', Department: r.Department, Conveyor: r.Conveyor, Ref: r.TicketNo }], false);
  if (!res.ok) throw new Error(res.errors[0].error);
  var used = readTable('ConsumableTransactions').filter(function (x) { return x.Ref === r.TicketNo; }).map(function (x) { return x.BatchNo; });
  updateWhere('ConsumableRequests', 'RequestNo', r.RequestNo, { Status: CREQ.ISSUED, IssuedQty: qty, IssuedBatch: used.join(', '), IssuedOn: new Date() });
  audit(admin.UserID, 'issueConsumable', r.TicketNo, { qty: qty });
  return { status: CREQ.ISSUED, batches: used };
}
