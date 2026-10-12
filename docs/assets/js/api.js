// Talks to the Apps Script API, or to an in-browser demo backend when no API_URL is set.
(function () {
  var TOKEN_KEY = 'rtg.token';

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; }
  }

  // Read-only actions are kept on this device so a page shows at once: the saved copy is shown first,
  // then fetched fresh in the background, and api.onFresh(action, data) is told when it changed.
  // Any change (approve, issue, save...) wipes the saved copies so nobody acts on old data.
  var READS = { dashboard: 1, lookups: 1, heaterSearch: 1, components: 1, listUsers: 1, listRequests: 1, getRequest: 1,
                listTransfers: 1, listConsumables: 1, consumableDetail: 1, listConsumableRequests: 1, maintenanceDue: 1,
                listMaintenanceLogs: 1, storageInfo: 1, masterList: 1, adminLog: 1, consumableItems: 1 };
  var CACHE_KEY = 'rtg.cache', USER_KEY = 'rtg.user', FRESH_MS = 15000, MAX_ENTRIES = 40;
  var cache = loadCache(), inflight = {};

  function loadCache() {
    try { var c = JSON.parse(store(CACHE_KEY) || 'null'); if (c && c.token === store(TOKEN_KEY)) return c; } catch (e) { /* ignore */ }
    return { token: store(TOKEN_KEY), entries: {} };
  }
  function saveCache() {
    var keys = Object.keys(cache.entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort(function (a, b) { return cache.entries[a].t - cache.entries[b].t; });
      keys.slice(0, keys.length - MAX_ENTRIES).forEach(function (k) { delete cache.entries[k]; });
    }
    store(CACHE_KEY, JSON.stringify(cache));
  }
  function clearCache() { cache = { token: api.token, entries: {} }; store(CACHE_KEY, null); }

  function send(req) {
    return api.demo ? demoHandle(req) : fetch(window.RTG_CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req)
    }).then(function (r) { return r.json(); });
  }
  function unwrap(res) {
    if (!res.ok) {
      var err = new Error(res.error || 'Something went wrong.');
      err.auth = res.auth;
      throw err;
    }
    return res.data;
  }
  function fetchRead(k, req) {
    if (inflight[k]) return inflight[k];
    var p = send(req).then(unwrap).then(function (data) {
      cache.entries[k] = { t: Date.now(), data: data };
      saveCache();
      return data;
    });
    inflight[k] = p;
    p.then(done, done);
    function done() { delete inflight[k]; }
    return p;
  }

  var api = {
    demo: !window.RTG_CONFIG.API_URL,
    token: store(TOKEN_KEY),
    onFresh: null,
    call: function (action, data) {
      var req = { action: action, token: api.token, data: data || {} };
      if (!READS[action]) {
        return send(req).then(unwrap).then(function (d) {
          if (action !== 'me') clearCache();
          return d;
        });
      }
      var k = action + '|' + JSON.stringify(req.data), hit = cache.entries[k];
      if (!hit) return fetchRead(k, req).then(copy);
      if (Date.now() - hit.t > FRESH_MS) {
        var before = JSON.stringify(hit.data);
        fetchRead(k, req).then(function (fresh) {
          if (JSON.stringify(fresh) !== before && api.onFresh) api.onFresh(action, copy(fresh));
        }).catch(function (err) { if (err.auth && api.onFresh) api.onFresh('auth', null); });
      }
      return Promise.resolve(copy(hit.data));
    },
    // The last signed-in user, so the app can open without waiting for the server.
    savedUser: function () {
      try { return api.token ? JSON.parse(store(USER_KEY) || 'null') : null; } catch (e) { return null; }
    },
    saveUser: function (u) { store(USER_KEY, JSON.stringify(u)); },
    login: function (userId, password) {
      return api.call('login', { userId: userId, password: password }).then(function (d) {
        api.token = d.token;
        store(TOKEN_KEY, d.token);
        clearCache();
        api.saveUser(d.user);
        return d.user;
      });
    },
    logout: function () {
      var p = api.call('logout').catch(function () {});
      api.token = null;
      store(TOKEN_KEY, null);
      store(USER_KEY, null);
      clearCache();
      return p;
    }
  };
  function copy(d) { return d === undefined ? d : JSON.parse(JSON.stringify(d)); }

  // ---------- Demo backend ----------
  // Runs the real Apps Script backend code in this browser against fake Sheet services,
  // with the data kept in localStorage. Nothing leaves the browser.
  var DEMO_KEY = 'rtg.demo.v8';
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
      addDemoUser('rtg01', 'rtg12345', { Name: 'Demo RTG Team', EmployeeID: '100004', Role: 'Local', Team: 'RTG', Email: 'rtg01@example.com' });
      addDemoUser('vendor', 'vendor123', { Name: 'Demo Jointing Vendor', EmployeeID: 'V9002', Role: 'Local', Team: 'Vendor', Department: 'ABC Belting', Email: 'vendor@example.com' });
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
