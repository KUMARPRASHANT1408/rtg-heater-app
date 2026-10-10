// JSON API for the GitHub Pages front end.
// The front end POSTs {action, token, data} as text/plain (avoids the CORS preflight Apps Script can't answer).

var ADMIN = ['Admin'];
var READ_ONLY = ['me', 'lookups', 'heaterSearch', 'components', 'listUsers', 'listRequests', 'getRequest', 'dashboard'];

// action -> { roles: who may call it (null = any logged-in user), run: function(user, data) }
var ACTIONS = {
  me:             { roles: null,  run: function (u) { return { user: publicUser(u) }; } },
  changePassword: { roles: null,  run: function (u, d) { return changePassword(u, d.oldPassword, d.newPassword); } },
  lookups:        { roles: null,  run: function () { return apiLookups(); } },
  heaterSearch:   { roles: null,  run: function (u, d) { return apiHeaterSearch(d); } },
  components:     { roles: ADMIN, run: function (u, d) { return apiComponents(d); } },
  listUsers:      { roles: ADMIN, run: function () { return listUsers(); } },
  saveUser:       { roles: ADMIN, run: function (u, d) { return saveUser(u, d); } },
  resetPassword:  { roles: ADMIN, run: function (u, d) { return resetPassword(u, d.UserID); } },
  raiseRequest:   { roles: null,  run: function (u, d) { return raiseRequest(u, d); } },
  listRequests:   { roles: null,  run: function () { return listRequests(); } },
  getRequest:     { roles: null,  run: function (u, d) { return getRequest(u, d); } },
  dashboard:      { roles: null,  run: function () { return dashboard(); } },
  decideRequest:  { roles: ADMIN, run: function (u, d) { return decideRequest(u, d); } },
  issueTicket:    { roles: ADMIN, run: function (u, d) { return issueTicket(u, d); } },
  returnTicket:   { roles: ADMIN, run: function (u, d) { return returnTicket(u, d); } },
  closeIssue:     { roles: ADMIN, run: function (u, d) { return closeIssue(u, d); } },
  maintenance:    { roles: ADMIN, run: function (u, d) { return completeMaintenance(u, d); } },
  markFound:      { roles: ADMIN, run: function (u, d) { return markFound(u, d); } }
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
