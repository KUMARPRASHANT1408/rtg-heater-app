// JSON API for the GitHub Pages front end.
// The front end POSTs {action, token, data} as text/plain (avoids the CORS preflight Apps Script can't answer).

var ADMIN = ['Admin'];
var READ_ONLY = ['me', 'lookups', 'heaterSearch', 'components', 'listUsers', 'listRequests', 'getRequest', 'dashboard', 'listTransfers',
                 'listConsumables', 'consumableDetail', 'consumableItems', 'listConsumableRequests',
                 'maintenanceDue', 'listMaintenanceLogs', 'getChecklist', 'masterList', 'adminLog'];

// action -> { roles: roles allowed (null = any logged-in user), allow: extra check on the user, run: function(user, data) }
// STORE: RTG and RTG Vendor (see stock, issue, take back). RTG: the RTG team (approve). STOCK: RTG Vendor (change stock).
function STORE(u) { return isStoreUser_(u); }
function RTG(u) { return isRtgTeam_(u); }
function STOCK(u) { return canUpdateStock_(u); }
var ACTIONS = {
  me:             { roles: null,  run: function (u) { return { user: publicUser(u) }; } },
  changePassword: { roles: null,  run: function (u, d) { return changePassword(u, d.oldPassword, d.newPassword); } },
  lookups:        { roles: null,  run: function () { return apiLookups(); } },
  heaterSearch:   { allow: STORE, run: function (u, d) { return apiHeaterSearch(d); } },
  components:     { allow: STORE, run: function (u, d) { return apiComponents(d); } },
  listUsers:      { roles: ADMIN, run: function () { return listUsers(); } },
  saveUser:       { roles: ADMIN, run: function (u, d) { return saveUser(u, d); } },
  resetPassword:  { roles: ADMIN, run: function (u, d) { return resetPassword(u, d.UserID); } },
  deleteUser:     { roles: ADMIN, run: function (u, d) { return deleteUser(u, d.UserID); } },
  raiseRequest:   { roles: null,  run: function (u, d) { return raiseRequest(u, d); } },
  listRequests:   { roles: null,  run: function () { return listRequests(); } },
  getRequest:     { roles: null,  run: function (u, d) { return getRequest(u, d); } },
  dashboard:      { roles: null,  run: function (u) { return dashboard(u); } },
  decideRequest:  { allow: RTG,   run: function (u, d) { return decideRequest(u, d); } },
  issueTicket:    { allow: STORE, run: function (u, d) { return issueTicket(u, d); } },
  returnTicket:   { allow: STORE, run: function (u, d) { return returnTicket(u, d); } },
  closeIssue:     { allow: RTG,   run: function (u, d) { return closeIssue(u, d); } },
  declareReturn:  { roles: null,  run: function (u, d) { return declareReturn(u, d); } },
  explainIssue:   { roles: null,  run: function (u, d) { return explainIssue(u, d); } },
  maintenance:    { allow: STOCK, run: function (u, d) { return completeMaintenance(u, d); } },
  markFound:      { allow: STOCK, run: function (u, d) { return markFound(u, d); } },
  raiseTransfer:  { roles: null,  run: function (u, d) { return raiseTransfer(u, d); } },
  decideTransfer: { roles: null,  run: function (u, d) { return decideTransfer(u, d); } },
  listTransfers:  { roles: null,  run: function (u) { return listTransfers(u); } },
  listConsumables:          { allow: STORE, run: function () { return listConsumables(); } },
  consumableDetail:         { allow: STORE, run: function (u, d) { return consumableDetail(d); } },
  consumableItems:          { roles: null,  run: function () { return consumableItems(); } },
  saveConsumable:           { allow: STOCK, run: function (u, d) { return saveConsumable(u, d); } },
  stockEntry:               { allow: STOCK, run: function (u, d) { return stockEntry(u, d); } },
  uploadStock:              { allow: STOCK, run: function (u, d) { return uploadStock(u, d); } },
  raiseConsumableRequest:   { roles: null,  run: function (u, d) { return raiseConsumableRequest(u, d); } },
  listConsumableRequests:   { roles: null,  run: function (u) { return listConsumableRequests(u); } },
  decideConsumableRequest:  { allow: RTG,   run: function (u, d) { return decideConsumableRequest(u, d); } },
  issueConsumable:          { allow: STORE, run: function (u, d) { return issueConsumable(u, d); } },
  maintenanceDue:           { roles: null,  run: function (u) { return maintenanceDue(u); } },
  logMaintenance:           { roles: null,  run: function (u, d) { return logMaintenance(u, d); } },
  listMaintenanceLogs:      { allow: STORE, run: function (u) { return listMaintenanceLogs(u); } },
  getChecklist:             { allow: STORE, run: function (u, d) { return getChecklist(u, d); } },
  verifyMaintenance:        { allow: RTG,   run: function (u, d) { return verifyMaintenance(u, d); } },
  masterList:               { roles: ADMIN, run: function (u, d) { return apiMasterList(d); } },
  masterSave:               { roles: ADMIN, run: function (u, d) { return apiMasterSave(u, d); } },
  masterDelete:             { roles: ADMIN, run: function (u, d) { return apiMasterDelete(u, d); } },
  adminLog:                 { roles: ADMIN, run: function (u, d) { return apiLog(d); } },
  clearTestData:            { roles: ADMIN, run: function (u) { clearTestData(); audit(u.UserID, 'clearTestData'); return { ok: true }; } }
};

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  return json_(handle(req));
}

function doGet() {
  return json_({ ok: true, app: 'RTG Heater API' });
}

// Separate from doPost so tests can call it directly.
function handle(req) {
  try {
    if (req.action === 'login') return { ok: true, data: login(req.data.userId, req.data.password) };
    if (req.action === 'logout') return { ok: true, data: logout(req.token) };
    var a = ACTIONS[req.action];
    if (!a) return { ok: false, error: 'Unknown action: ' + req.action };
    var user = requireUser(req.token, a.roles);
    if (a.allow && !a.allow(user)) throw new Error('You do not have permission for this.');
    if (READ_ONLY.indexOf(req.action) >= 0) return { ok: true, data: a.run(user, req.data || {}) };
    // One writer at a time, so two people can't approve or issue the same thing at once.
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      return { ok: true, data: a.run(user, req.data || {}) };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), auth: !!err.auth };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
