// Talks to the Apps Script API, or to an in-browser demo backend when no API_URL is set.
(function () {
  var TOKEN_KEY = 'rtg.token';

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; }
  }

  var api = {
    demo: !window.RTG_CONFIG.API_URL,
    token: store(TOKEN_KEY),
    call: function (action, data) {
      var req = { action: action, token: api.token, data: data || {} };
      var p = api.demo ? demoHandle(req) : fetch(window.RTG_CONFIG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(req)
      }).then(function (r) { return r.json(); });
      return p.then(function (res) {
        if (!res.ok) {
          var err = new Error(res.error || 'Something went wrong.');
          err.auth = res.auth;
          throw err;
        }
        return res.data;
      });
    },
    login: function (userId, password) {
      return api.call('login', { userId: userId, password: password }).then(function (d) {
        api.token = d.token;
        store(TOKEN_KEY, d.token);
        return d.user;
      });
    },
    logout: function () {
      var p = api.call('logout').catch(function () {});
      api.token = null;
      store(TOKEN_KEY, null);
      return p;
    }
  };

  // ---------- Demo backend ----------
  // Runs the real Apps Script backend code in this browser against fake Sheet services,
  // with the data kept in localStorage. Nothing leaves the browser.
  var DEMO_KEY = 'rtg.demo.v5';
  var backend = null;

  function demoBackend() {
    if (backend) return backend;
    var services = GasFake.makeServices({ load: function () { return store(DEMO_KEY); }, save: function (s) { store(DEMO_KEY, s); } });
    backend = GasFake.loadBackend(window.RTG_BACKEND_SOURCE, services);
    if (!services.SpreadsheetApp.getActive().getSheetByName('Users')) {
      backend.setup();
      backend.loadSampleData();
      setDemoUser('admin', 'admin123', { Name: 'Demo Admin', EmployeeID: '100001' });
      addDemoUser('fm01', 'fm12345', { Name: 'Demo FM User', EmployeeID: '200001', Role: 'Local', Team: 'FM', Department: 'FM', Email: 'fm01@example.com' });
      addDemoUser('hod', 'hod12345', { Name: 'Demo RTG HOD', EmployeeID: '100002', Role: 'HOD', Team: 'RTG', Email: 'hod@example.com' });
      addDemoUser('rchief', 'chief123', { Name: 'Demo RTG Chief', EmployeeID: '100003', Role: 'RTG Chief', Team: 'RTG', Email: 'rchief@example.com' });
      addDemoUser('fchief', 'chief123', { Name: 'Demo FM Chief', EmployeeID: '200002', Role: 'FM Chief', Team: 'FM', Email: 'fchief@example.com' });
      addDemoUser('vendor', 'vendor123', { Name: 'Demo Maintenance Vendor', EmployeeID: 'V9001', Role: 'Local', Team: 'Vendor', Department: 'ABC Heater Services', Email: 'vendor@example.com' });
      // One set back from a joint, so the maintenance page has work to show.
      ['TP', 'BP', 'CP', 'PB', 'PC1', 'PC2', 'T1', 'T2', 'SB1', 'SB2', 'CBS'].forEach(function (c) {
        backend.updateWhere('Components', 'ComponentID', 'HM-03-S2-' + c, { MaintenanceStatus: 'Due', JointsSinceMaintenance: 1 });
      });
      services.__save();
    }
    return backend;
  }
  function setDemoUser(id, pw, fields) {
    var salt = backend.newSalt();
    backend.updateWhere('Users', 'UserID', id, Object.assign({ Salt: salt, PasswordHash: backend.hashPassword(pw, salt), MustChangePassword: false }, fields));
  }
  function addDemoUser(id, pw, fields) {
    backend.appendRow('Users', Object.assign({ UserID: id, Active: true, CreatedOn: new Date() }, fields));
    setDemoUser(id, pw, {});
  }

  function demoHandle(req) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var b = demoBackend();
        var res = b.handle(JSON.parse(JSON.stringify(req)));
        b.services.__save();
        resolve(JSON.parse(JSON.stringify(res)));
      }, 120);
    });
  }

  api.resetDemo = function () { store(DEMO_KEY, null); };
  window.API = api;
})();
