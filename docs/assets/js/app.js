// RTG Heater Store front end: hash router + views.
(function () {
  var state = { user: null, lookups: null };
  var view = document.getElementById('view');
  var charts = [];

  // ---------- helpers ----------
  function esc(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function isAdmin() { return state.user && state.user.Role === 'Admin'; }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function showError(el, err) { el.textContent = err.message || String(err); el.classList.remove('hidden'); }
  function formData(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
    });
    return o;
  }
  function busy(btn, on) { if (btn) btn.disabled = on; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function clearCharts() { charts.forEach(function (c) { c.destroy(); }); charts = []; }
  function handleError(err) {
    if (err.auth) { API.logout(); state.user = null; location.hash = '#/login'; return; }
    view.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>';
  }

  // ---------- routing ----------
  var NAV = [
    { hash: '#/home', label: 'Home' },
    { hash: '#/heaters', label: 'Find a heater' },
    { hash: '#/requests', label: 'Requests' },
    { hash: '#/transfers', label: 'Transfers' },
    { hash: '#/consumables', label: 'Consumables' },
    { hash: '#/maintenance', label: 'Maintenance', maint: true },
    { hash: '#/inventory', label: 'Inventory', admin: true },
    { hash: '#/users', label: 'Users', admin: true }
  ];
  var ROUTES = { '#/home': renderHome, '#/heaters': renderHeaters, '#/inventory': renderInventory, '#/users': renderUsers,
                 '#/requests': renderRequests, '#/request': renderNewRequest, '#/ticket': renderTicket, '#/transfers': renderTransfers,
                 '#/consumables': renderConsumables, '#/consumable': renderConsumable, '#/maintenance': renderMaintenance };
  var ADMIN_ROUTES = ['#/inventory', '#/users'];

  // '#/ticket/RTGH0001?x=1' -> {base: '#/ticket', arg: 'RTGH0001', params: {x: '1'}}
  function parseHash() {
    var h = location.hash || '#/home';
    var q = h.indexOf('?');
    var path = q >= 0 ? h.slice(0, q) : h, params = {};
    if (q >= 0) h.slice(q + 1).split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    var parts = path.split('/');
    return { base: parts.slice(0, 2).join('/'), arg: parts.slice(2).join('/') ? decodeURIComponent(parts.slice(2).join('/')) : '', params: params };
  }

  function route() {
    clearCharts();
    if (!state.user) return renderLogin();
    var h = parseHash();
    if (ADMIN_ROUTES.indexOf(h.base) >= 0 && !isAdmin()) h = { base: '#/home', arg: '', params: {} };
    renderChrome(h.base === '#/ticket' || h.base === '#/request' ? '#/requests' : h.base === '#/consumable' ? '#/consumables' : h.base);
    (ROUTES[h.base] || renderHome)(h.arg, h.params);
  }

  function renderChrome(hash) {
    $('#topbar').classList.remove('hidden');
    $('#who-name').textContent = state.user.Name;
    $('#who-role').textContent = state.user.Role;
    $('#nav').innerHTML = NAV.filter(function (n) { return (!n.admin || isAdmin()) && (!n.maint || canMaintain()); }).map(function (n) {
      return '<a href="' + n.hash + '"' + (hash === n.hash ? ' class="active"' : '') + '>' + esc(n.label) + '</a>';
    }).join('');
  }

  // ---------- login ----------
  function renderLogin() {
    $('#topbar').classList.add('hidden');
    view.innerHTML =
      '<div class="login-wrap"><div class="card login-card">' +
      '<span class="brand-mark">♨</span><h1>RTG Heater Store</h1>' +
      '<p class="muted">Heater and consumables issue, return and tracking.</p>' +
      '<form id="form-login">' +
      '<label>User ID<input name="userId" required autocomplete="username" autofocus></label>' +
      '<label>Password<input name="password" type="password" required autocomplete="current-password"></label>' +
      '<div class="alert error hidden" id="login-error"></div>' +
      '<button class="btn" type="submit">Log in</button>' +
      '<p class="muted small">Forgot your password? Ask an RTG admin to reset it.</p>' +
      '</form></div></div>';
    document.body.classList.add('is-login');
    $('#form-login').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = formData(e.target), btn = $('button', e.target);
      busy(btn, true);
      API.login(f.userId, f.password).then(function (user) {
        state.user = user;
        document.body.classList.remove('is-login');
        afterLogin();
      }).catch(function (err) { showError($('#login-error'), err); busy(btn, false); });
    });
  }

  function afterLogin() {
    // Load dropdown lists first so every screen has them.
    return API.call('lookups').catch(function () { return { conveyors: [], departments: [], models: [] }; }).then(function (l) {
      state.lookups = l;
      $('#dept-list').innerHTML = l.departments.map(function (d) { return '<option value="' + esc(d) + '">'; }).join('');
      if (location.hash === '#/login' || !location.hash) location.hash = '#/home';
      else route();
      if (state.user.MustChangePassword) openPassword(true);
    });
  }

  // ---------- home ----------
  function renderHome() {
    var tiles = [
      { href: '#/heaters', ico: '🔎', title: 'Find a heater', text: 'Enter belt width and rating to see suitable heaters, what is available and where the rest are deployed.' },
      { href: '#/requests', ico: '📝', title: 'Requests & tickets', text: 'Track every request and ticket: pending, approved, on site, overdue or closed. Search by number.' },
      { href: '#/transfers', ico: '🔁', title: 'Site transfers', text: 'Move a deployed heater to another conveyor with RTG, HOD and Chiefs approval. See where each request is pending.' },
      { href: '#/consumables', ico: '🧪', title: 'Consumables', text: 'Stock, expiry, monthly and department-wise consumption, and requests.' }
    ];
    if (canMaintain()) tiles.splice(isAdmin() ? 3 : 0, 0, { href: '#/maintenance', ico: '🛠️', title: 'Heater maintenance', text: 'Log daily maintenance with the filled checklist. RTG verifies it, then the parts are ready to issue again.' });
    if (isAdmin()) {
      tiles.splice(1, 0, { href: '#/inventory', ico: '🧰', title: 'Heater inventory', text: 'Every component, its condition, status and where it is.' });
      tiles.push({ href: '#/calculator', ico: '📐', title: 'Joint calculator', text: 'Minimum joint length and step length from belt width, rating and plies.', soon: true });
      tiles.push({ href: '#/users', ico: '👥', title: 'Users', text: 'Add people, choose admins and approvers, reset passwords.' });
    }
    view.innerHTML =
      '<div class="page-head"><div><h1>Welcome, ' + esc(state.user.Name) + '</h1><p class="muted">What would you like to do?</p></div></div>' +
      '<div class="grid grid-3">' + tiles.map(function (t) {
        return '<a class="card tile' + (t.soon ? ' soon' : '') + '" href="' + t.href + '"><span class="ico">' + t.ico + '</span>' +
          (t.soon ? '<span class="soon-tag">Coming next</span>' : '') +
          '<h2>' + esc(t.title) + '</h2><p class="muted small">' + esc(t.text) + '</p></a>';
      }).join('') + '</div>';
    var head = $('.page-head', view);
    var box = document.createElement('div');
    box.className = 'grid grid-5';
    box.style.marginBottom = '20px';
    head.after(box);
    API.call('dashboard').then(function (d) {
      function t(label, v, f, tone) {
        return '<a class="card stat tile" href="#/requests?f=' + f + '"><div class="label">' + esc(label) + '</div><div class="value"' + (tone && v ? ' style="color:var(--' + tone + ')"' : '') + '>' + v + '</div></a>';
      }
      var mine = d.transfersForMe ? '<a class="card stat tile accent" href="#/transfers?f=mine"><div class="label">Transfers waiting for you</div><div class="value" style="color:var(--warn)">' + d.transfersForMe + '</div></a>' : '';
      box.innerHTML = mine + t('Pending approval', d.pending, 'Pending', 'warn') + t('Awaiting pickup', d.awaiting, 'Awaiting pickup') + t('Heaters on site', d.onSite, 'onsite') +
        t('Overdue', d.overdue, 'overdue', 'bad') + t('Open issues', d.openIssues, 'issue', 'bad') +
        (d.maintenanceToVerify && isAdmin() ? '<a class="card stat tile" href="#/maintenance?f=verify"><div class="label">Maintenance logs to check</div><div class="value" style="color:var(--warn)">' + d.maintenanceToVerify + '</div></a>' : '') +
        (d.consumablePending ? '<a class="card stat tile" href="#/consumables?f=requests"><div class="label">Consumable requests</div><div class="value" style="color:var(--warn)">' + d.consumablePending + '</div></a>' : '') +
        (d.consumableAlerts ? '<a class="card stat tile" href="#/consumables"><div class="label">Consumables low or expiring</div><div class="value" style="color:var(--bad)">' + d.consumableAlerts + '</div></a>' : '');
    }).catch(function () { box.remove(); });
  }

  // ---------- heater search ----------
  function guideWidths() {
    var g = (state.lookups && state.lookups.guide) || [], seen = {};
    return g.map(function (x) { return Number(x.BeltWidth_mm); }).filter(function (w) { if (!w || seen[w]) return false; seen[w] = true; return true; }).sort(function (a, b) { return a - b; });
  }

  function renderHeaters() {
    var conv = (state.lookups && state.lookups.conveyors) || [];
    view.innerHTML =
      '<div class="page-head"><div><h1>Find a suitable heater</h1><p class="muted">Pick a conveyor or type the belt details.</p></div></div>' +
      '<form class="card" id="form-search"><div class="row">' +
      '<label>Conveyor (optional)<select name="conveyor"><option value="">Choose to auto-fill</option>' +
      conv.map(function (c) { return '<option value="' + esc(c.ConveyorName) + '">' + esc(c.ConveyorName) + (c.Area ? ' · ' + esc(c.Area) : '') + '</option>'; }).join('') +
      '</select></label>' +
      '<label>Belt width (mm)<input name="width" type="number" min="1" required inputmode="numeric" list="guide-widths"></label>' +
      '<datalist id="guide-widths">' + guideWidths().map(function (w) { return '<option value="' + w + '">'; }).join('') + '</datalist>' +
      '<label>Belt rating (N/mm)<input name="rating" required list="guide-ratings" placeholder="e.g. 1000 or ST1000" autocomplete="off"></label>' +
      '<datalist id="guide-ratings"></datalist>' +
      '<label>No. of plies<input name="plies" type="number" min="1" inputmode="numeric"></label>' +
      '<button class="btn" type="submit">Show heaters</button>' +
      '</div></form><div id="results" class="stack" style="margin-top:20px"></div>';
    var form = $('#form-search');
    // Suggest the ratings the selection guide lists for the typed width (steel-cord ones like ST1000 included).
    function fillRatings() {
      var w = Number(form.width.value), seen = {};
      var list = ((state.lookups && state.lookups.guide) || []).filter(function (g) { return !w || Number(g.BeltWidth_mm) === w; })
        .map(function (g) { return String(g.BeltRating); }).filter(function (v) { if (!v || seen[v]) return false; seen[v] = true; return true; });
      $('#guide-ratings').innerHTML = list.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
    }
    fillRatings();
    form.width.addEventListener('input', fillRatings);
    form.rating.addEventListener('blur', function () {
      var v = form.rating.value.trim().toUpperCase().replace(/\s+/g, '');
      form.rating.value = /^(ST)?\d+$/.test(v) ? v : form.rating.value.trim();
    });
    form.conveyor.addEventListener('change', function () {
      var c = conv.filter(function (x) { return x.ConveyorName === form.conveyor.value; })[0];
      if (!c) return;
      form.width.value = c.BeltWidth_mm || ''; form.rating.value = c.BeltRating_Nmm || ''; form.plies.value = c.Plies || '';
      fillRatings();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = formData(form), btn = $('button', form);
      if (!/^(ST)?\d+$/i.test(String(f.rating).replace(/\s+/g, ''))) { toast('Type the rating as a number like 1000, or ST1000 for a steel-cord belt.'); return; }
      busy(btn, true);
      $('#results').innerHTML = '<p class="muted">Checking the store…</p>';
      API.call('heaterSearch', { width: f.width, rating: f.rating, plies: f.plies })
        .then(function (r) { r.conveyor = f.conveyor; renderResults(r); }).catch(handleError).then(function () { busy(btn, false); });
    });
  }

  function statTile(label, value, accent) {
    return '<div class="card stat' + (accent ? ' accent' : '') + '"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div></div>';
  }

  function renderResults(r) {
    clearCharts();
    var t = r.totals, el = $('#results');
    var html =
      '<div class="grid grid-5">' +
      statTile('Total heaters in RTG Store', t.heatersInStore) +
      statTile('Suitable for this belt', t.suitableTotal) +
      statTile('Suitable & ready to issue', t.suitableAvailable, true) +
      statTile('Suitable, out on site', t.suitableDeployed) +
      statTile('Ready to issue (all types)', t.availableAll) +
      '</div>';
    if (!r.suitable.length) {
      var g = r.guide, hint = '';
      if (g && g.optionsForWidth.length) hint = '<p>For a ' + esc(r.query.width) + ' mm belt the selection guide lists these ratings: <b>' + g.optionsForWidth.map(esc).join(', ') + '</b>. Check the belt rating and plies.</p>';
      else if (g) hint = '<p>The selection guide has no entry for a ' + esc(r.query.width) + ' mm belt. It covers: ' + g.widths.join(', ') + ' mm.</p>';
      el.innerHTML = html + '<div class="card"><h2>No suitable heater</h2><p class="muted">' + (g ? 'The RTG selection guide has no heater' : 'No heater model covers') + ' for a ' + esc(r.query.width) + ' mm belt at ' + esc(r.query.rating) + ' N/mm' + (r.query.plies ? ' with ' + esc(r.query.plies) + ' plies' : '') + '. Contact the RTG Store.</p>' + hint + '</div>';
      return;
    }
    html += '<div class="card"><h2>Suitable heater sets</h2>' +
      '<div class="legend" style="margin:6px 0 10px"><span><i style="background:var(--series-1)"></i>Ready to issue</span><span><i style="background:var(--series-2)"></i>Out on site</span><span><i style="background:var(--series-muted)"></i>Not usable (damaged, missing or maintenance due)</span></div>' +
      '<div class="chart-box" style="height:' + Math.max(140, 56 * r.suitable.length + 50) + 'px"><canvas id="chart-sets" aria-label="Heater sets by status"></canvas></div></div>';

    html += r.suitable.map(function (s) {
      var m = s.model, blocked = s.blockedBy && s.blockedBy.length ? 1 : 0;
      var notUsable = Math.max(0, s.totalSets - s.availableSets - s.deployedCount - blocked);
      var total = Math.max(1, s.totalSets);
      return '<div class="card model-card">' +
        '<div class="model-head"><div><h2>' + esc(m.ModelName) + '</h2><div class="kv">' +
        '<span>Width <b>' + esc(m.BeltWidthMin_mm) + '–' + esc(m.BeltWidthMax_mm) + ' mm</b></span>' +
        (m.RatingMax_Nmm ? '<span>Rating up to <b>' + esc(m.RatingMax_Nmm) + ' N/mm</b></span>' : '') +
        (m.PliesMax ? '<span>Plies up to <b>' + esc(m.PliesMax) + '</b></span>' : '') +
        (s.madeFrom && s.madeFrom.length ? '<span>Pair of <b>' + s.madeFrom.map(esc).join(' + ') + '</b></span>' : '') +
        '</div></div>' +
        (s.availableSets > 0 ? '<span class="pill good">✓ ' + s.availableSets + ' ready to issue</span>' : '<span class="pill bad">✕ None ready</span>') +
        '</div>' +
        '<div class="meter" role="img" aria-label="' + s.availableSets + ' ready, ' + s.deployedCount + ' out, ' + notUsable + ' not usable">' +
        '<span style="width:' + (100 * s.availableSets / total) + '%;background:var(--series-1)"></span>' +
        '<span style="width:' + (100 * s.deployedCount / total) + '%;background:var(--series-2)"></span>' +
        '<span style="width:' + (100 * notUsable / total) + '%;background:var(--series-muted)"></span></div>' +
        (blocked ? '<p class="small">Not ready as a pair: ' + s.blockedBy.map(function (b) { return esc(b.via) + ' is out on ' + esc(b.ticket) + (b.conveyor ? ' (' + esc(b.conveyor) + ')' : ''); }).join(', ') + '.</p>' : '') +
        s.deployments.filter(function (d) { return d.via; }).map(function (d) { return '<p class="small">Out as part of pair ' + esc(d.via) + ' on ' + esc(d.ticket) + '.</p>'; }).join('') +
        '<div class="kv"><span>Sets owned <b>' + s.totalSets + '</b></span><span>Ready <b>' + s.availableSets + '</b></span><span>Out on site <b>' + s.deployedCount + '</b></span><span>Not usable <b>' + notUsable + '</b></span></div>' +
        (s.shortages.length && s.shortages.length < s.componentList.length ? '<p class="small muted">Limiting parts for one more set: ' + s.shortages.map(function (x) { return esc(x.component) + ' (' + x.have + ' of ' + x.need + ')'; }).join(', ') + '</p>' : '') +
        '<details><summary>Components in one set</summary><div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Component</th><th class="num">Per set</th><th class="num">Ready in store</th></tr></thead><tbody>' +
        s.componentList.map(function (c) { return '<tr><td>' + esc(c.name) + '</td><td class="num">' + c.perSet + '</td><td class="num">' + c.available + '</td></tr>'; }).join('') +
        '</tbody></table></div></details>' +
        '<div class="actions">' + (s.availableSets > 0 ? '<a class="btn" href="#/request/new?model=' + encodeURIComponent(m.ModelID) + '&w=' + esc(r.query.width) + '&r=' + esc(r.query.rating) + '&c=' + encodeURIComponent(r.conveyor || '') + '">Request this heater</a>' : '<button class="btn" type="button" disabled>None available to request</button>') + '</div>' +
        '</div>';
    }).join('');

    html += '<div class="card"><h2>Where the suitable heaters are deployed</h2>' + (r.deployments.length ?
      '<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Heater</th><th>Conveyor</th></tr></thead><tbody>' +
      r.deployments.map(function (d) { return '<tr><td>' + esc(d.ticket) + '</td><td>' + esc(d.model) + '</td><td>' + esc(d.conveyor) + '</td></tr>'; }).join('') +
      '</tbody></table></div>' : '<p class="muted">None out on site right now.</p>') + '</div>';

    el.innerHTML = html;
    drawSetsChart(r.suitable);
  }

  function drawSetsChart(list) {
    if (!window.Chart) return;
    var surface = cssVar('--surface'), text2 = cssVar('--text-2'), grid = cssVar('--border');
    function ds(label, color, fn) {
      return { label: label, data: list.map(fn), backgroundColor: color, borderColor: surface, borderWidth: 2, borderRadius: 4, borderSkipped: false, barThickness: 22 };
    }
    charts.push(new Chart($('#chart-sets'), {
      type: 'bar',
      data: {
        labels: list.map(function (s) { return s.model.ModelName; }),
        datasets: [
          ds('Ready to issue', cssVar('--series-1'), function (s) { return s.availableSets; }),
          ds('Out on site', cssVar('--series-2'), function (s) { return s.deployedCount; }),
          ds('Not usable', cssVar('--series-muted'), function (s) { return Math.max(0, s.totalSets - s.availableSets - s.deployedCount); })
        ]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { left: 4 } },
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          x: { stacked: true, beginAtZero: true, ticks: { precision: 0, color: text2 }, grid: { color: grid }, title: { display: true, text: 'Heater sets', color: text2 } },
          y: { stacked: true, grid: { display: false }, ticks: { color: text2, callback: function (v) {
            var l = this.getLabelForValue(v), max = window.innerWidth < 600 ? 14 : 40;
            return l.length > max ? l.slice(0, max - 1) + '…' : l;
          } } }
        }
      }
    }));
  }

  // ---------- status helpers ----------
  var STATUS_PILL = {
    'Pending': 'warn', 'Rejected': 'bad', 'Awaiting pickup': 'info', 'Issued': 'info', 'Partly returned': 'warn',
    'Returned with issue': 'bad', 'Closed': 'good'
  };
  function statusPill(status, overdue) {
    return '<span class="pill ' + (STATUS_PILL[status] || 'info') + '">' + esc(status) + '</span>' + (overdue ? ' <span class="pill bad">⚠ Overdue</span>' : '');
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function field(label, value) {
    return '<div><div class="small muted">' + esc(label) + '</div><div><b>' + esc(value || '—') + '</b></div></div>';
  }

  // ---------- new request ----------
  function renderNewRequest(arg, params) {
    var models = (state.lookups && state.lookups.models) || [];
    var conv = (state.lookups && state.lookups.conveyors) || [];
    var model = models.filter(function (m) { return m.ModelID === params.model; })[0];
    if (!model) {
      view.innerHTML = '<div class="card"><h2>Choose a heater first</h2><p class="muted">Find a suitable heater for your belt, then press <b>Request this heater</b>.</p><a class="btn" href="#/heaters">Find a heater</a></div>';
      return;
    }
    view.innerHTML = '<div class="page-head"><div><h1>Request a heater</h1><p class="muted">' + esc(model.ModelName) + '</p></div><a class="btn secondary" href="#/heaters">Back</a></div><p class="muted">Loading…</p>';
    API.call('heaterSearch', { width: params.w || model.BeltWidthMin_mm, rating: params.r || 0 }).then(function (res) {
      var stats = res.suitable.filter(function (s) { return s.model.ModelID === model.ModelID; })[0] || { componentList: [] };
      var t = todayStr();
      view.innerHTML =
        '<div class="page-head"><div><h1>Request a heater</h1><p class="muted">' + esc(model.ModelName) + ' · ' + esc(stats.availableSets) + ' set(s) ready in store</p></div><a class="btn secondary" href="#/heaters">Back</a></div>' +
        '<form id="form-request" class="stack">' +
        '<div class="card stack"><h2>Issue details</h2><div class="row">' +
        '<label>Conveyor name<input name="ConveyorName" required list="conv-list" value="' + esc(params.c || '') + '"></label>' +
        '<label>Vendor team name<input name="VendorTeam" required></label>' +
        '<label>Vendor team supervisor<input name="VendorSupervisor" required></label>' +
        '<label>Vendor employee ID (collecting)<input name="VendorEmployeeID" required></label>' +
        '</div><div class="row">' +
        '<label>FM representative<input name="FMRepresentative" required value="' + esc(state.user.Team === 'FM' ? state.user.Name : '') + '"></label>' +
        '<label>FM representative email<input name="FMEmail" type="email" value="' + esc(state.user.Team === 'FM' ? state.user.Email : '') + '"></label>' +
        '<label>Date of issue<input name="IssueDate" type="date" required min="' + t + '" value="' + t + '"></label>' +
        '<label>Expected return date<input name="ExpectedReturnDate" type="date" required min="' + t + '"></label>' +
        '</div></div>' +
        '<div class="card"><h2>Components needed</h2><p class="muted small">A full set is selected. Untick or reduce anything you don\'t need. Every component issued must be returned.</p>' +
        '<div class="table-wrap"><table><thead><tr><th style="width:40px"></th><th>Component</th><th class="num">Ready in store</th><th class="num" style="width:120px">Quantity</th></tr></thead><tbody>' +
        stats.componentList.map(function (c, i) {
          return '<tr><td><input type="checkbox" data-i="' + i + '" checked style="min-height:auto"></td><td>' + esc(c.name) + '</td><td class="num">' + c.available + '</td>' +
            '<td class="num"><input type="number" min="1" max="' + c.available + '" value="' + Math.min(c.perSet, c.available) + '" data-q="' + i + '" style="width:90px;text-align:right"></td></tr>';
        }).join('') + '</tbody></table></div></div>' +
        '<div class="alert error hidden" id="req-error"></div>' +
        '<div class="actions"><button class="btn" type="submit">Raise request</button></div></form>' +
        '<datalist id="conv-list">' + conv.map(function (c) { return '<option value="' + esc(c.ConveyorName) + '">'; }).join('') + '</datalist>';
      var form = $('#form-request');
      form.IssueDate.addEventListener('change', function () { form.ExpectedReturnDate.min = form.IssueDate.value; });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var d = formData(form);
        d.ModelID = model.ModelID; d.BeltWidth_mm = params.w || ''; d.BeltRating_Nmm = params.r || '';
        d.RequestedComponents = stats.componentList.map(function (c, i) {
          return { name: c.name, qty: $('[data-i="' + i + '"]', form).checked ? Number($('[data-q="' + i + '"]', form).value) : 0 };
        }).filter(function (c) { return c.qty > 0; });
        var btn = $('button[type=submit]', form);
        busy(btn, true);
        API.call('raiseRequest', d).then(function (r) {
          toast('Request ' + r.RequestNo + ' raised');
          location.hash = '#/ticket/' + r.RequestNo;
        }).catch(function (err) { showError($('#req-error'), err); busy(btn, false); });
      });
    }).catch(handleError);
  }

  // ---------- requests list ----------
  var FILTERS = [
    { key: 'open', label: 'Open', fn: function (r) { return ['Rejected', 'Closed'].indexOf(r.Status) < 0; } },
    { key: 'Pending', label: 'Pending approval' },
    { key: 'Awaiting pickup', label: 'Awaiting pickup' },
    { key: 'onsite', label: 'On site', fn: function (r) { return ['Issued', 'Partly returned'].indexOf(r.Status) >= 0; } },
    { key: 'overdue', label: 'Overdue', fn: function (r) { return r.Overdue; } },
    { key: 'issue', label: 'With issue', fn: function (r) { return r.Status === 'Returned with issue' || r.OpenIssue; } },
    { key: 'Closed', label: 'Closed' },
    { key: 'Rejected', label: 'Rejected' },
    { key: 'all', label: 'All', fn: function () { return true; } }
  ];

  function renderRequests(arg, params) {
    var active = params.f || 'open';
    view.innerHTML = '<div class="page-head"><div><h1>Requests &amp; tickets</h1><p class="muted">Every heater request, its ticket and where it stands.</p></div>' +
      '<a class="btn" href="#/heaters">+ New request</a></div><p class="muted">Loading…</p>';
    Promise.all([API.call('listRequests'), API.call('dashboard')]).then(function (res) {
      var list = res[0], dash = res[1];
      function tile(label, value, f, tone) {
        return '<a class="card stat tile' + (active === f ? ' accent' : '') + '" href="#/requests?f=' + f + '"><div class="label">' + esc(label) + '</div><div class="value"' + (tone && value ? ' style="color:var(--' + tone + ')"' : '') + '>' + value + '</div></a>';
      }
      var filter = FILTERS.filter(function (f) { return f.key === active; })[0] || FILTERS[0];
      var rows = list.filter(filter.fn || function (r) { return r.Status === filter.key; });
      view.innerHTML =
        '<div class="page-head"><div><h1>Requests &amp; tickets</h1><p class="muted">Every heater request, its ticket and where it stands.</p></div><a class="btn" href="#/heaters">+ New request</a></div>' +
        '<div class="grid grid-5" style="margin-bottom:16px">' +
        tile('Pending approval', dash.pending, 'Pending', 'warn') + tile('Awaiting pickup', dash.awaiting, 'Awaiting pickup') +
        tile('On site', dash.onSite, 'onsite') + tile('Overdue', dash.overdue, 'overdue', 'bad') + tile('Open issues', dash.openIssues, 'issue', 'bad') + '</div>' +
        '<div class="card"><form id="form-find" class="row" style="margin-bottom:14px">' +
        '<label>Search request or ticket number<input name="no" placeholder="RTGH0001 or HEATER_0001" required></label>' +
        '<div><button class="btn" type="submit">Open</button></div>' +
        '<label>Show<select id="f-filter">' + FILTERS.map(function (f) { return '<option value="' + f.key + '"' + (f.key === filter.key ? ' selected' : '') + '>' + esc(f.label) + '</option>'; }).join('') + '</select></label></form>' +
        '<div class="table-wrap"><table><thead><tr><th>Request</th><th>Ticket</th><th>Heater</th><th>Conveyor</th><th>Vendor team</th><th>Return by</th><th>Status</th></tr></thead><tbody>' +
        (rows.map(function (r) {
          return '<tr class="click" data-no="' + esc(r.RequestNo) + '"><td><b>' + esc(r.RequestNo) + '</b><div class="small muted">' + esc(r.RaisedOn) + '</div></td><td>' + esc(r.TicketNo || '—') + '</td><td>' + esc(r.ModelName) +
            '</td><td>' + esc(r.ConveyorName) + '</td><td>' + esc(r.VendorTeam) + '<div class="small muted">' + esc(r.FMRepresentative) + '</div></td><td>' + esc(r.ExpectedReturnDate) + '</td><td>' + statusPill(r.Status, r.Overdue) + '</td></tr>';
        }).join('') || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>') +
        '</tbody></table></div></div>';
      $('#f-filter').addEventListener('change', function () { location.hash = '#/requests?f=' + encodeURIComponent(this.value); });
      $('#form-find').addEventListener('submit', function (e) { e.preventDefault(); location.hash = '#/ticket/' + encodeURIComponent(formData(e.target).no.toUpperCase()); });
      $('tbody', view).addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-no]');
        if (tr) location.hash = '#/ticket/' + tr.dataset.no;
      });
    }).catch(handleError);
  }

  // ---------- ticket page ----------
  function renderTicket(no) {
    view.innerHTML = '<p class="muted">Loading ' + esc(no) + '…</p>';
    API.call('getRequest', { no: no }).then(function (d) { drawTicket(d); }).catch(function (err) {
      if (err.auth) return handleError(err);
      view.innerHTML = '<div class="card"><h2>Not found</h2><p class="muted">' + esc(err.message) + '</p><a class="btn" href="#/requests">Back to requests</a></div>';
    });
  }

  function steps(d) {
    var r = d.request, tk = d.ticket;
    var list = [
      { label: 'Requested', done: true, when: r.RaisedOn },
      { label: r.Status === 'Rejected' ? 'Rejected' : 'Approved', done: r.Status !== 'Pending', bad: r.Status === 'Rejected', when: r.DecidedOn }
    ];
    if (r.Status !== 'Rejected') {
      list.push({ label: 'Issued', done: !!(tk && tk.IssuedOn), when: tk && tk.IssuedOn });
      var handed = (d.items || []).filter(function (i) { return i.ReturnDeclaredOn; }).map(function (i) { return i.ReturnDeclaredOn; }).sort();
      list.push({ label: 'Handed back by FM', done: handed.length > 0 || !!(tk && tk.ReturnedOn), when: handed[handed.length - 1] });
      list.push({ label: 'Returned', done: !!(tk && tk.ReturnedOn), when: tk && tk.ReturnedOn, bad: tk && tk.Status === 'Returned with issue' });
      list.push({ label: 'Closed', done: !!(tk && tk.Status === 'Closed'), when: tk && tk.ClosedOn });
    }
    return '<ol class="steps">' + list.map(function (s) {
      return '<li class="' + (s.bad ? 'bad' : s.done ? 'done' : '') + '"><span class="dot"></span><span>' + esc(s.label) + '</span><span class="small muted">' + esc(s.when || '') + '</span></li>';
    }).join('') + '</ol>';
  }

  function drawTicket(d) {
    var r = d.request, tk = d.ticket, model = d.model || {};
    var status = tk ? tk.Status : r.Status;
    var outstanding = d.items.filter(function (i) { return !i.ConditionIn; });
    var html =
      '<div class="page-head"><div><div class="small muted"><a href="#/requests">Requests</a> / ' + esc(r.RequestNo) + '</div>' +
      '<h1>' + esc(tk ? tk.TicketNo : r.RequestNo) + ' ' + statusPill(status, d.overdue) + '</h1>' +
      '<p class="muted">' + esc(model.ModelName) + ' for ' + esc(tk ? tk.ConveyorName : r.ConveyorName) + (tk ? ' · request ' + esc(r.RequestNo) : '') + '</p></div></div>' +
      '<div class="card" style="margin-bottom:16px">' + steps(d) + '</div>' +
      '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start">' +
      '<div class="card stack"><h2>Details</h2><div class="details">' +
      field('Conveyor', tk ? tk.ConveyorName : r.ConveyorName) + field('Heater', model.ModelName) + field('Vendor team', r.VendorTeam) + field('Vendor supervisor', r.VendorSupervisor) +
      field('Vendor employee ID', r.VendorEmployeeID) + field('FM representative', r.FMRepresentative) + field('Date of issue', r.IssueDate) +
      field('Expected return', tk ? tk.ExpectedReturnDate : r.ExpectedReturnDate) + field('Raised by', d.raisedByName) + field('Raised on', r.RaisedOn) +
      (r.Status === 'Rejected' ? field('Reject reason', r.RejectReason) : '') + (tk && tk.IssuedOn ? field('Issued on', tk.IssuedOn) : '') +
      '</div></div>' +
      '<div class="card stack"><h2>' + (d.items.length ? 'Components on this ticket' : 'Components requested') + '</h2>' +
      (d.items.length ?
        '<div class="table-wrap"><table><thead><tr><th>Component ID</th><th>Component</th><th class="num">Qty</th><th>Returned</th></tr></thead><tbody>' +
        d.items.map(function (i) {
          var cond = i.ConditionIn;
          var pill = !cond ? (i.ReturnDeclaredOn ? '<span class="pill warn">Handed back, to inspect</span>' : '<span class="pill info">On site</span>') : cond === 'OK' ? '<span class="pill good">OK</span>' : '<span class="pill bad">' + esc(cond) + '</span>';
          return '<tr><td><b>' + esc(i.ComponentID) + '</b></td><td>' + esc(i.ComponentName) + (i.Remarks ? '<div class="small muted">' + esc(i.Remarks) + '</div>' : '') + '</td><td class="num">' + esc(i.QtyOut) + '</td><td>' + pill + '</td></tr>';
        }).join('') + '</tbody></table></div>' :
        '<div class="table-wrap"><table><thead><tr><th>Component</th><th class="num">Qty</th></tr></thead><tbody>' +
        r.RequestedComponents.map(function (c) { return '<tr><td>' + esc(c.name) + '</td><td class="num">' + esc(c.qty) + '</td></tr>'; }).join('') + '</tbody></table></div>') +
      '</div></div>';

    if (d.issues.length) {
      html += '<div class="card stack" style="margin-top:16px"><h2>Issues</h2>' + d.issues.map(function (i) {
        var parts = [];
        try { parts = JSON.parse(i.AffectedComponents || '[]'); } catch (e) {}
        var pill = i.Status === 'Closed' ? '<span class="pill good">Closed</span>' : i.Status === 'Explained' ? '<span class="pill warn">Explained, RTG to review</span>' : '<span class="pill bad">Waiting for FM explanation</span>';
        var body = '<div class="issue"><div class="model-head"><b>' + esc(i.IssueNo) + '</b>' + pill + '</div>' +
          '<p>' + esc(i.Description) + '</p><p class="small muted">' + parts.map(function (p) { return esc(p.id) + ' ' + esc(p.name) + ': ' + esc(p.result) + (p.remarks ? ' (' + esc(p.remarks) + ')' : ''); }).join(' · ') + '</p>' +
          (i.FMExplanation ? '<p class="small"><b>What happened (FM):</b> ' + esc(i.FMExplanation) + '</p>' : '') +
          (i.FMActionPlan ? '<p class="small"><b>Action FM will take:</b> ' + esc(i.FMActionPlan) + '</p>' : '') +
          (i.ClosingRemark ? '<p class="small"><b>RTG remark:</b> ' + esc(i.ClosingRemark) + '</p>' : '');
        if (i.Status === 'Open' && !isAdmin() && fmCanAct(d)) {
          body += '<form class="stack" data-explain="' + esc(i.IssueNo) + '"><label>What happened<textarea name="explanation" rows="2" required></textarea></label>' +
            '<label>What action you will take<textarea name="actionPlan" rows="2" required></textarea></label>' +
            '<div class="actions"><button class="btn" type="submit">Send explanation to RTG</button></div></form>';
        }
        if (isAdmin() && i.Status === 'Explained') {
          body += '<form class="row" data-issue="' + esc(i.IssueNo) + '"><label>Your remark (optional)<input name="remark"></label><div><button class="btn" type="submit">Accept &amp; close</button></div></form>';
        }
        if (isAdmin() && i.Status === 'Open') {
          body += '<details><summary class="small">FM explained outside the app? Type it in</summary><form class="row" data-issue="' + esc(i.IssueNo) + '" style="margin-top:8px">' +
            '<label>FM explanation<textarea name="explanation" rows="2" required></textarea></label><div><button class="btn secondary" type="submit">Record &amp; close</button></div></form></details>';
        }
        return body + '</div>';
      }).join('') + '</div>';
    }

    html += transferSection(d, status);
    if (isAdmin()) html += adminPanel(d, status, outstanding);
    else html += fmReturnPanel(d, status, outstanding);
    view.innerHTML = html;
    wireTicket(d, outstanding);
    wireTransferSection(d, function (msg) { if (msg) toast(msg); renderTicket(d.ticket.TicketNo); });
  }

  function fmCanAct(d) {
    return isAdmin() || state.user.Team === 'FM' || d.request.RaisedBy === state.user.UserID;
  }

  // FM hands the heater back: ticks what they are returning; RTG inspects it next.
  function fmReturnPanel(d, status, outstanding) {
    var open = outstanding.filter(function (i) { return !i.ReturnDeclaredOn; });
    if (!fmCanAct(d) || !open.length || ['Issued', 'Partly returned', 'Returned with issue'].indexOf(status) < 0) return '';
    return '<div class="card stack" style="margin-top:16px"><h2>Return the heater</h2>' +
      '<p class="muted small">Tick the parts you are handing back to the RTG Store. Untick anything still on site. RTG will then inspect each part.</p>' +
      '<form id="form-handback" class="stack"><div class="table-wrap"><table><thead><tr><th style="width:40px"></th><th>Component ID</th><th>Component</th><th class="num">Qty</th></tr></thead><tbody>' +
      open.map(function (i) {
        return '<tr><td><input type="checkbox" checked data-hb="' + esc(i.ComponentID) + '" style="min-height:auto"></td><td><b>' + esc(i.ComponentID) + '</b></td><td>' + esc(i.ComponentName) + '</td><td class="num">' + esc(i.QtyOut) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<label>Note for RTG (optional)<input name="note" placeholder="e.g. joint completed, one cable still at site"></label>' +
      '<div class="alert error hidden" id="handback-error"></div><div class="actions"><button class="btn" type="submit">Hand back to RTG Store</button></div></form></div>';
  }

  function adminPanel(d, status, outstanding) {
    var r = d.request;
    if (r.Status === 'Pending') {
      return '<div class="card stack" style="margin-top:16px"><h2>Decision</h2>' +
        '<form id="form-decide" class="stack"><label>Reason (needed to reject)<textarea name="reason" rows="2" placeholder="Mailed to the FM / vendor team if you reject"></textarea></label>' +
        '<div class="alert error hidden" id="decide-error"></div>' +
        '<div class="actions"><button class="btn secondary" type="button" data-decision="reject">Reject</button><button class="btn" type="button" data-decision="approve">Approve &amp; create ticket</button></div></form></div>';
    }
    if (status === 'Awaiting pickup' && d.suggestion) {
      var usableByName = {};
      d.usable.forEach(function (c) { (usableByName[c.ComponentName] = usableByName[c.ComponentName] || []).push(c); });
      return '<div class="card stack" style="margin-top:16px"><h2>Issue at the store</h2>' +
        '<p class="muted small">Parts are suggested from one set where possible. Change any ID to match what you physically hand over.</p>' +
        (d.suggestion.short.length ? '<div class="alert error">Not enough in store: ' + d.suggestion.short.map(function (s) { return esc(s.name) + ' (short by ' + s.missing + ')'; }).join(', ') + '</div>' : '') +
        '<form id="form-issue" class="stack"><div class="table-wrap"><table><thead><tr><th style="width:40px"></th><th>Component</th><th>Component ID handed over</th><th class="num" style="width:110px">Qty</th></tr></thead><tbody>' +
        d.suggestion.picks.map(function (p, i) {
          var opts = (usableByName[p.ComponentName] || []).map(function (c) {
            return '<option value="' + esc(c.ComponentID) + '"' + (c.ComponentID === p.ComponentID ? ' selected' : '') + '>' + esc(c.ComponentID) + (Number(c.Qty) > 1 ? ' (' + c.Qty + ' in lot)' : '') + '</option>';
          }).join('');
          return '<tr><td><input type="checkbox" checked data-pick="' + i + '" style="min-height:auto"></td><td>' + esc(p.ComponentName) + '</td><td><select data-id="' + i + '">' + opts + '</select></td>' +
            '<td class="num">' + (p.lot ? '<input type="number" min="1" value="' + p.Qty + '" data-qty="' + i + '" style="width:80px;text-align:right">' : '1') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="alert error hidden" id="issue-error"></div>' +
        '<div class="actions"><button class="btn" type="submit">Issue to FM team</button></div></form></div>';
    }
    if (outstanding.length && ['Issued', 'Partly returned', 'Returned with issue'].indexOf(status) >= 0) {
      return '<div class="card stack" style="margin-top:16px"><h2>Return &amp; inspection</h2>' +
        '<p class="muted small">Parts FM handed back are set to OK. Change any that are damaged or missing. Anything left as "Not returned" stays on site and keeps the ticket open.</p>' +
        '<form id="form-return" class="stack"><div class="actions" style="justify-content:flex-start"><button class="btn secondary small" type="button" id="all-ok">Mark all OK</button></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Component ID</th><th>Component</th><th>Result</th><th>Remarks</th></tr></thead><tbody>' +
        outstanding.map(function (i, n) {
          return '<tr><td><b>' + esc(i.ComponentID) + '</b></td><td>' + esc(i.ComponentName) + (Number(i.QtyOut) > 1 ? ' x' + esc(i.QtyOut) : '') + '</td><td><select data-res="' + n + '">' +
            ['Not returned', 'OK', 'Damaged', 'Missing'].map(function (o) { return '<option' + (i.ReturnDeclaredOn && o === 'OK' ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>' +
            (i.ReturnDeclaredOn ? '<div class="small muted">FM handed back ' + esc(String(i.ReturnDeclaredOn).slice(0, 10)) + '</div>' : '') + '</td>' +
            '<td><input data-rem="' + n + '" placeholder="Optional"></td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<label id="issue-box" class="hidden">Describe the damage / missing parts (mailed to the FM team asking for an explanation)<textarea name="issueText" rows="3"></textarea></label>' +
        '<div class="alert error hidden" id="return-error"></div>' +
        '<div class="actions"><button class="btn" type="submit" id="return-btn">Save return</button></div></form></div>';
    }
    return '';
  }

  function wireTicket(d, outstanding) {
    var r = d.request, tk = d.ticket;
    var reload = function (msg) { if (msg) toast(msg); renderTicket(tk ? tk.TicketNo : r.RequestNo); };
    view.querySelectorAll('form[data-issue]').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = formData(f);
        API.call('closeIssue', { IssueNo: f.dataset.issue, explanation: fd.explanation, remark: fd.remark }).then(function (res) { reload('Issue closed. Ticket is now ' + res.status.toLowerCase()); }).catch(function (err) { toast(err.message); });
      });
    });
    view.querySelectorAll('form[data-explain]').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = formData(f), btn = $('button', f);
        busy(btn, true);
        API.call('explainIssue', { IssueNo: f.dataset.explain, explanation: fd.explanation, actionPlan: fd.actionPlan })
          .then(function () { reload('Explanation sent to the RTG Store'); }).catch(function (err) { toast(err.message); busy(btn, false); });
      });
    });
    var hand = $('#form-handback');
    if (hand) hand.addEventListener('submit', function (e) {
      e.preventDefault();
      var ids = Array.prototype.map.call(hand.querySelectorAll('[data-hb]:checked'), function (x) { return x.dataset.hb; });
      var btn = $('button[type=submit]', hand);
      busy(btn, true);
      API.call('declareReturn', { TicketNo: tk.TicketNo, ComponentIDs: ids, note: hand.note.value.trim() })
        .then(function (res) { reload('Handed back ' + res.declared + ' component(s). RTG will inspect them.'); })
        .catch(function (err) { showError($('#handback-error'), err); busy(btn, false); });
    });
    var decide = $('#form-decide');
    if (decide) decide.addEventListener('click', function (e) {
      var b = e.target.closest('[data-decision]');
      if (!b) return;
      var reason = decide.reason.value.trim();
      if (b.dataset.decision === 'reject' && !reason) return showError($('#decide-error'), new Error('Write a reason before rejecting.'));
      busy(b, true);
      API.call('decideRequest', { RequestNo: r.RequestNo, decision: b.dataset.decision, reason: reason }).then(function (res) {
        if (res.TicketNo) { toast('Approved: ticket ' + res.TicketNo); location.hash = '#/ticket/' + res.TicketNo; } else reload('Request rejected and FM informed');
      }).catch(function (err) { showError($('#decide-error'), err); busy(b, false); });
    });
    var issue = $('#form-issue');
    if (issue) issue.addEventListener('submit', function (e) {
      e.preventDefault();
      var items = d.suggestion.picks.map(function (p, i) {
        if (!$('[data-pick="' + i + '"]', issue).checked) return null;
        var q = $('[data-qty="' + i + '"]', issue);
        return { ComponentID: $('[data-id="' + i + '"]', issue).value, Qty: q ? Number(q.value) : 1 };
      }).filter(Boolean);
      var btn = $('button[type=submit]', issue);
      busy(btn, true);
      API.call('issueTicket', { TicketNo: tk.TicketNo, items: items }).then(function () { reload('Issued ' + items.length + ' components'); })
        .catch(function (err) { showError($('#issue-error'), err); busy(btn, false); });
    });
    var ret = $('#form-return');
    if (ret) {
      var update = function () {
        var vals = outstanding.map(function (i, n) { return $('[data-res="' + n + '"]', ret).value; });
        var problem = vals.some(function (v) { return v === 'Damaged' || v === 'Missing'; });
        var pending = vals.some(function (v) { return v === 'Not returned'; });
        $('#issue-box').classList.toggle('hidden', !problem);
        $('#return-btn').textContent = problem ? 'Raise issue & mail FM' : pending ? 'Save partial return' : 'Close ticket';
        $('#return-btn').classList.toggle('danger', problem);
      };
      ret.addEventListener('change', update);
      $('#all-ok').addEventListener('click', function () { ret.querySelectorAll('[data-res]').forEach(function (s) { s.value = 'OK'; }); update(); });
      update();
      ret.addEventListener('submit', function (e) {
        e.preventDefault();
        var items = outstanding.map(function (i, n) {
          return { ComponentID: i.ComponentID, result: $('[data-res="' + n + '"]', ret).value, remarks: $('[data-rem="' + n + '"]', ret).value.trim() };
        });
        var btn = $('#return-btn');
        busy(btn, true);
        API.call('returnTicket', { TicketNo: tk.TicketNo, items: items, issueText: ret.issueText.value.trim() }).then(function (res) {
          reload(res.status === 'Closed' ? 'Ticket closed' : res.issueNo ? 'Issue ' + res.issueNo + ' raised and FM informed' : 'Return saved, ' + res.stillOut + ' still on site');
        }).catch(function (err) { showError($('#return-error'), err); busy(btn, false); });
      });
    }
  }

  // ---------- site transfers ----------
  var STAGE_LABEL = { 'RTG': 'RTG team', 'HOD': 'RTG HOD', 'RTG Chief': 'RTG Chief', 'FM Chief': 'FM Chief' };
  var TRANSFER_PILL = { 'Pending RTG': 'warn', 'Pending HOD': 'warn', 'Pending Chiefs': 'warn', 'Approved': 'good', 'Rejected': 'bad', 'Cancelled': 'info' };

  function transferCard(t, withTicketLink) {
    var rejected = t.Status === 'Rejected';
    var tracker = '<ol class="steps">' + t.stages.map(function (s) {
      var waiting = t.waitingWith.indexOf(STAGE_LABEL[s.stage]) >= 0 || t.waitingWith.indexOf(s.stage) >= 0;
      var cls = s.decision === 'Approved' ? 'done' : s.decision === 'Rejected' ? 'bad' : waiting ? 'now' : '';
      var sub = s.decision ? s.decision + ' by ' + s.byName + (s.on ? ' · ' + s.on : '') : waiting ? 'Waiting' : rejected || t.Status === 'Cancelled' ? '—' : 'Not yet';
      return '<li class="' + cls + '"><span class="dot"></span><span>' + esc(STAGE_LABEL[s.stage]) + '</span><span class="small muted">' + esc(sub) + '</span>' +
        (s.comment ? '<span class="small">“' + esc(s.comment) + '”</span>' : '') + '</li>';
    }).join('') + '</ol>';
    var where = t.waitingWith.length ? 'Pending with ' + t.waitingWith.join(' and ') : t.Status === 'Approved' ? 'Fully approved: heater may move' : t.Status === 'Rejected' ? 'Rejected: heater must come back to the RTG Store' : 'Cancelled: heater was returned';
    return '<div class="card stack transfer" data-tno="' + esc(t.TransferNo) + '">' +
      '<div class="model-head"><div><h2>' + esc(t.TransferNo) + ' <span class="pill ' + (TRANSFER_PILL[t.Status] || 'info') + '">' + esc(t.Status) + '</span></h2>' +
      '<div class="kv"><span>' + (withTicketLink ? '<a href="#/ticket/' + esc(t.TicketNo) + '">' + esc(t.TicketNo) + '</a>' : esc(t.TicketNo)) + '</span>' +
      '<span><b>' + esc(t.FromConveyor) + '</b> → <b>' + esc(t.ToConveyor) + '</b></span><span>Return by <b>' + esc(t.NewExpectedReturn) + '</b></span>' +
      '<span>Raised by ' + esc(t.RaisedByName) + ' (' + esc(t.EmployeeID) + ') · ' + esc(t.RaisedOn) + '</span></div></div>' +
      '<b class="' + (t.waitingWith.length ? 'warn-text' : '') + '">' + esc(where) + '</b></div>' +
      '<p style="margin:0"><span class="muted small">Reason</span><br>' + esc(t.Reason) + '</p>' + tracker +
      (t.canDecide ? '<form class="stack" data-decide="' + esc(t.TransferNo) + '"><label>Comment (needed to reject)<textarea name="comment" rows="2"></textarea></label>' +
        '<div class="alert error hidden"></div><div class="actions"><button class="btn secondary" type="button" data-d="reject">Reject</button><button class="btn" type="button" data-d="approve">Approve</button></div></form>' : '') +
      '</div>';
  }

  function wireTransferDecisions(root, after) {
    root.querySelectorAll('form[data-decide]').forEach(function (f) {
      f.addEventListener('click', function (e) {
        var b = e.target.closest('[data-d]');
        if (!b) return;
        var comment = f.comment.value.trim(), err = $('.alert', f);
        if (b.dataset.d === 'reject' && !comment) return showError(err, new Error('Write a reason before rejecting.'));
        busy(b, true);
        API.call('decideTransfer', { TransferNo: f.dataset.decide, decision: b.dataset.d, comment: comment }).then(function (r) {
          after(r.status === 'Approved' ? 'Fully approved: the heater may move' : r.status === 'Rejected' ? 'Rejected: FM told to return the heater' : 'Approved and sent to the next approver');
        }).catch(function (x) { showError(err, x); busy(b, false); });
      });
    });
  }

  function renderTransfers(arg, params) {
    var show = params.f || 'pending';
    view.innerHTML = '<div class="page-head"><div><h1>Site transfers</h1><p class="muted">Moving a used heater to another conveyor without maintenance needs RTG, HOD, RTG Chief and FM Chief approval.</p></div></div><p class="muted">Loading…</p>';
    API.call('listTransfers').then(function (list) {
      var filters = { pending: function (t) { return t.waitingWith.length; }, mine: function (t) { return t.canDecide; }, all: function () { return true; } };
      var rows = list.filter(filters[show] || filters.pending);
      var mine = list.filter(filters.mine).length;
      view.innerHTML =
        '<div class="page-head"><div><h1>Site transfers</h1><p class="muted">Moving a used heater to another conveyor without maintenance needs RTG, HOD, RTG Chief and FM Chief approval.</p></div>' +
        '<p class="muted small" style="max-width:280px">To ask for a move, open the ticket of a heater on site and press <b>Move to another site</b>.</p></div>' +
        '<div class="chips">' + [['pending', 'Waiting for approval'], ['mine', 'Waiting for me' + (mine ? ' (' + mine + ')' : '')], ['all', 'All']].map(function (c) {
          return '<a class="chip' + (show === c[0] ? ' active' : '') + '" href="#/transfers?f=' + c[0] + '">' + esc(c[1]) + '</a>';
        }).join('') + '</div>' +
        '<div class="stack">' + (rows.map(function (t) { return transferCard(t, true); }).join('') || '<div class="card"><p class="muted">Nothing here.</p></div>') + '</div>';
      wireTransferDecisions(view, function (msg) { toast(msg); renderTransfers(arg, params); });
    }).catch(handleError);
  }

  function transferSection(d, status) {
    var pending = d.transfers.some(function (t) { return t.waitingWith.length; });
    var canMove = ['Issued', 'Partly returned'].indexOf(status) >= 0 && !pending;
    if (!d.transfers.length && !canMove) return '';
    var conv = (state.lookups && state.lookups.conveyors) || [];
    return '<div class="stack" style="margin-top:16px"><div class="model-head"><h2 style="margin:0">Site transfers</h2>' +
      (canMove ? '<button class="btn secondary" type="button" id="open-move">Move to another site</button>' : '') + '</div>' +
      (canMove ? '<form id="form-move" class="card stack hidden"><h2>Request to move this heater</h2>' +
        '<p class="muted small">A heater should be used for one joint and then maintained. Moving it without maintenance needs approval from the RTG team, RTG HOD, RTG Chief and FM Chief.</p>' +
        '<div class="row"><label>Move to conveyor<input name="ToConveyor" required list="conv-list2"></label>' +
        '<label>Your employee ID<input name="EmployeeID" required value="' + esc(state.user.EmployeeID || '') + '"></label>' +
        '<label>New expected return date<input name="NewExpectedReturn" type="date" required min="' + todayStr() + '"></label></div>' +
        '<div class="row"><label>Vendor team at new site<input name="VendorTeam" value="' + esc(d.request.VendorTeam) + '"></label>' +
        '<label>Vendor supervisor<input name="VendorSupervisor" value="' + esc(d.request.VendorSupervisor) + '"></label></div>' +
        '<label>Reason (why it can\'t come back for maintenance first)<textarea name="Reason" rows="3" required minlength="10"></textarea></label>' +
        '<div class="alert error hidden" id="move-error"></div><div class="actions"><button class="btn" type="submit">Send for approval</button></div>' +
        '<datalist id="conv-list2">' + conv.map(function (c) { return '<option value="' + esc(c.ConveyorName) + '">'; }).join('') + '</datalist></form>' : '') +
      d.transfers.map(function (t) { return transferCard(t, false); }).join('') + '</div>';
  }

  function wireTransferSection(d, reload) {
    var open = $('#open-move'), form = $('#form-move');
    if (open) open.addEventListener('click', function () { form.classList.remove('hidden'); open.classList.add('hidden'); form.ToConveyor.focus(); });
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = formData(form);
      data.TicketNo = d.ticket.TicketNo;
      var btn = $('button[type=submit]', form);
      busy(btn, true);
      API.call('raiseTransfer', data).then(function (r) { reload('Transfer ' + r.TransferNo + ' sent to the RTG team for approval'); })
        .catch(function (err) { showError($('#move-error'), err); busy(btn, false); });
    });
    wireTransferDecisions(view, reload);
  }

  // ---------- heater inventory (admin) ----------
  function renderInventory() {
    view.innerHTML = '<div class="page-head"><div><h1>Heater inventory</h1><p class="muted">Every component in the RTG Store and on site.</p></div></div><p class="muted">Loading…</p>';
    API.call('components').then(function (rows) {
      var models = (state.lookups && state.lookups.models) || [];
      var name = {}; models.forEach(function (m) { name[m.ModelID] = m.ModelName; });
      function pill(c) {
        if (c.Status === STATUS.ISSUED) return '<span class="pill info">Issued</span>';
        if (c.Status === STATUS.MISSING) return '<span class="pill bad">Missing</span>';
        var out = [];
        if (c.Condition !== CONDITION.OK) out.push('<span class="pill ' + (c.Condition === CONDITION.SCRAPPED ? 'bad' : 'warn') + '">' + esc(c.Condition) + '</span>');
        if (c.MaintenanceStatus === MAINT.DUE) out.push('<span class="pill warn">Maintenance due</span>');
        return out.join(' ') || '<span class="pill good">In store</span>';
      }
      var counts = { inStore: 0, issued: 0, problem: 0 };
      rows.forEach(function (c) {
        if (c.Status === STATUS.ISSUED) counts.issued++;
        else if (isUsable(c)) counts.inStore++;
        else counts.problem++;
      });
      view.innerHTML =
        '<div class="page-head"><div><h1>Heater inventory</h1><p class="muted">Every component in the RTG Store and on site.</p></div></div>' +
        '<div class="grid grid-5" style="margin-bottom:16px">' + statTile('Components tracked', rows.length) + statTile('Ready in store', counts.inStore, true) + statTile('Issued', counts.issued) + statTile('Damaged / missing / maintenance', counts.problem) + '</div>' +
        '<div class="card"><div class="row" style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:14px">' +
        '<label>Heater model<select id="f-model"><option value="">All</option>' + models.map(function (m) { return '<option value="' + esc(m.ModelID) + '">' + esc(m.ModelName) + '</option>'; }).join('') + '</select></label>' +
        '<label>Status<select id="f-status"><option value="">All</option><option>In store</option><option>Issued</option><option>Maintenance due</option><option>Problem</option></select></label>' +
        '<label>Search<input id="f-q" placeholder="Component ID, name, conveyor…"></label></div>' +
        '<div class="actions hidden" id="bulk" style="justify-content:flex-start;margin-bottom:12px"><span class="muted small" id="bulk-n"></span>' +
        '<button class="btn small" type="button" data-act="maint">Maintenance done</button>' +
        '<button class="btn small secondary" type="button" data-act="repaired">Repaired &amp; maintained</button>' +
        '<button class="btn small secondary" type="button" data-act="found">Found (was missing)</button>' +
        '<button class="btn small danger" type="button" data-act="scrap">Scrap</button></div>' +
        '<div class="table-wrap"><table><thead><tr><th style="width:36px"></th><th>Component ID</th><th>Heater</th><th>Set</th><th>Component</th><th class="num">Qty</th><th>Status</th><th>Ticket / conveyor</th><th class="num">Joints since maint.</th></tr></thead><tbody id="inv-body"></tbody></table></div></div>';
      function draw() {
        var m = $('#f-model').value, st = $('#f-status').value, q = $('#f-q').value.toLowerCase();
        var list = rows.filter(function (c) {
          if (m && c.ModelID !== m) return false;
          if (st === 'In store' && !isUsable(c)) return false;
          if (st === 'Issued' && c.Status !== STATUS.ISSUED) return false;
          if (st === 'Problem' && (isUsable(c) || c.Status === STATUS.ISSUED)) return false;
          if (st === 'Maintenance due' && !(c.Status === STATUS.IN_STORE && c.MaintenanceStatus === MAINT.DUE)) return false;
          if (q && [c.ComponentID, c.ComponentName, c.CurrentConveyor, c.CurrentTicket, c.SerialNo].join(' ').toLowerCase().indexOf(q) < 0) return false;
          return true;
        });
        $('#inv-body').innerHTML = list.map(function (c) {
          var selectable = c.Status === STATUS.MISSING || (c.Status === STATUS.IN_STORE && !isUsable(c));
          return '<tr><td>' + (selectable ? '<input type="checkbox" data-sel="' + esc(c.ComponentID) + '" style="min-height:auto">' : '') + '</td><td><b>' + esc(c.ComponentID) + '</b></td><td>' + esc(name[c.ModelID] || c.ModelID) + '</td><td>' + esc(c.SetNo) + '</td><td>' + esc(c.ComponentName) +
            (c.Remarks ? '<div class="small muted">' + esc(c.Remarks) + '</div>' : '') + '</td><td class="num">' + esc(c.Qty) + '</td><td>' + pill(c) + '</td><td>' +
            esc(c.CurrentTicket) + (c.CurrentConveyor ? '<div class="small muted">' + esc(c.CurrentConveyor) + '</div>' : '') + '</td><td class="num">' + esc(c.JointsSinceMaintenance) + '</td></tr>';
        }).join('') || '<tr><td colspan="9" class="muted">No components match.</td></tr>';
        selection();
      }
      function selected() { return Array.prototype.map.call(view.querySelectorAll('[data-sel]:checked'), function (x) { return x.dataset.sel; }); }
      function selection() {
        var n = selected().length;
        $('#bulk').classList.toggle('hidden', !n);
        $('#bulk-n').textContent = n + ' selected';
      }
      $('#inv-body').addEventListener('change', selection);
      $('#bulk').addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        var ids = selected(), act = b.dataset.act;
        if (act === 'scrap' && !confirm('Scrap ' + ids.length + ' component(s)? They will no longer count as stock.')) return;
        busy(b, true);
        var p = act === 'found'
          ? ids.reduce(function (chain, id) { return chain.then(function () { return API.call('markFound', { ComponentID: id }); }); }, Promise.resolve())
          : API.call('maintenance', { ComponentIDs: ids, repaired: act === 'repaired', scrap: act === 'scrap' });
        p.then(function () { toast('Updated ' + ids.length + ' component(s)'); renderInventory(); }).catch(function (err) { toast(err.message); busy(b, false); });
      });
      ['#f-model', '#f-status', '#f-q'].forEach(function (s) { $(s).addEventListener('input', draw); });
      draw();
    }).catch(handleError);
  }

  // ---------- consumables ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var CREQ_PILL = { Pending: 'warn', Approved: 'info', Issued: 'good', Rejected: 'bad' };
  function qtyText(v, unit) { return esc(v === null || v === undefined || v === '' ? '—' : v) + (unit ? ' <span class="muted small">' + esc(unit) + '</span>' : ''); }

  // A small form dialog. fields: html. onSubmit(data, dialog, errorEl) returns a promise.
  function formDialog(title, fieldsHtml, submitLabel, onSubmit) {
    var d = document.createElement('dialog');
    d.innerHTML = '<form><h2>' + esc(title) + '</h2>' + fieldsHtml + '<div class="alert error hidden"></div>' +
      '<div class="actions"><button class="btn secondary" type="button" data-close>Cancel</button><button class="btn" type="submit">' + esc(submitLabel) + '</button></div></form>';
    document.body.appendChild(d);
    d.addEventListener('close', function () { d.remove(); });
    $('[data-close]', d).addEventListener('click', function () { d.close(); });
    var form = $('form', d);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', form);
      busy(btn, true);
      Promise.resolve(onSubmit(formData(form), d, $('.alert', form))).catch(function (err) { showError($('.alert', form), err); }).then(function () { busy(btn, false); });
    });
    d.showModal();
    return d;
  }

  function itemOptions(items, selected) {
    return items.map(function (i) { return '<option value="' + esc(i.ItemID) + '"' + (i.ItemID === selected ? ' selected' : '') + '>' + esc(i.ItemName) + '</option>'; }).join('');
  }

  function convOptions() {
    return ((state.lookups && state.lookups.conveyors) || []).map(function (c) { return '<option value="' + esc(c.ConveyorName) + '">'; }).join('');
  }

  function openStockEntry(items, itemId, done) {
    var d = formDialog('Update stock',
      '<label>Material<select name="ItemID" required>' + itemOptions(items, itemId) + '</select></label>' +
      '<div class="row"><label>What happened<select name="Type"><option value="Receipt">Received into store</option><option value="Issue">Issued / used</option><option value="Adjustment">Stock correction</option></select></label>' +
      '<label>Quantity<input name="Qty" type="number" step="any" required></label><label>Date<input name="Date" type="date" required value="' + todayStr() + '" max="' + todayStr() + '"></label></div>' +
      '<div class="row"><label>Batch number<input name="BatchNo" placeholder="Leave empty to use first expiring"></label><label data-for="Receipt">Expiry date<input name="ExpiryDate" type="date"></label></div>' +
      '<div class="row" data-for="Issue"><label>Department<input name="Department" list="dept-list"></label><label>Conveyor<input name="Conveyor" list="conv-list3"></label></div>' +
      '<div class="row"><label>Reference (challan, PO, note)<input name="Ref"></label><label>SAP stock today (optional)<input name="SAPStock" type="number" step="any"></label></div>' +
      '<p class="muted small" data-help></p><datalist id="conv-list3">' + convOptions() + '</datalist>',
      'Save', function (data, dlg) {
        return API.call('stockEntry', data).then(function () { dlg.close(); toast('Stock updated'); done(); });
      });
    var type = $('[name=Type]', d);
    var help = { Receipt: 'Adds to the batch. A new batch number starts a new batch with its own expiry date.',
                 Issue: 'Takes stock from the batch that expires first (expired stock is never issued), unless you name a batch.',
                 Adjustment: 'Corrects one batch after a physical count. Use a minus number to reduce it.' };
    function sync() {
      $('[data-for=Receipt]', d).classList.toggle('hidden', type.value !== 'Receipt');
      $('[data-for=Issue]', d).classList.toggle('hidden', type.value !== 'Issue');
      $('[name=Department]', d).required = type.value === 'Issue';
      $('[name=BatchNo]', d).required = type.value === 'Adjustment';
      $('[name=BatchNo]', d).placeholder = type.value === 'Receipt' ? 'e.g. the batch on the pack' : type.value === 'Issue' ? 'Leave empty to use first expiring' : 'Batch to correct';
      $('[data-help]', d).textContent = help[type.value];
    }
    type.addEventListener('change', sync);
    sync();
  }

  // ---- file upload (CSV) ----
  var UPLOAD_COLS = ['Date', 'ItemName', 'Type', 'Qty', 'BatchNo', 'ExpiryDate', 'Department', 'Conveyor', 'Ref', 'SAPStock'];
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');
    var sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }
  // Excel in India saves dates as 10-10-2026 or 10/10/2026 (day first). The app uses 2026-10-10.
  function normDate(v) {
    v = String(v || '').trim();
    var m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(v);
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    return v;
  }
  function csvToEntries(rows) {
    if (rows.length < 2) throw new Error('The file needs a header row and at least one data row.');
    var head = rows[0].map(function (h) { return String(h).trim().replace(/\s+/g, '').toLowerCase(); });
    var idx = {};
    UPLOAD_COLS.concat(['ItemID']).forEach(function (c) { idx[c] = head.indexOf(c.toLowerCase()); });
    if (idx.ItemName < 0 && idx.ItemID < 0) throw new Error('The header row needs an ItemName column. Download the template to see the layout.');
    ['Type', 'Qty'].forEach(function (c) { if (idx[c] < 0) throw new Error('The header row needs a ' + c + ' column.'); });
    return rows.slice(1).map(function (r) {
      var o = {};
      Object.keys(idx).forEach(function (c) { if (idx[c] >= 0) o[c] = String(r[idx[c]] === undefined ? '' : r[idx[c]]).trim(); });
      if (o.Date) o.Date = normDate(o.Date);
      if (o.ExpiryDate) o.ExpiryDate = normDate(o.ExpiryDate);
      return o;
    });
  }
  function downloadTemplate(items) {
    var lines = [UPLOAD_COLS.join(','),
      [todayStr(), items[0] ? items[0].ItemName : 'SAR Jointing Kit', 'Receipt', '10', 'B123', '2027-03-31', '', '', 'Challan 456', ''].join(','),
      [todayStr(), items[0] ? items[0].ItemName : 'SAR Jointing Kit', 'Issue', '2', '', '', 'FM', 'CNV-205', '', '']. join(',')];
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
    a.download = 'consumables_upload_template.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function openUpload(items, done) {
    var entries = null;
    var d = formDialog('Upload stock file',
      '<p class="muted small">Upload a CSV file (in Excel: <b>File → Save As → CSV</b>). One row per movement. <b>Type</b> is Receipt, Issue or Adjustment. ' +
      'Every row is checked first; nothing is saved unless all rows are correct.</p>' +
      '<p><button class="btn secondary small" type="button" data-tpl>Download template</button></p>' +
      '<label>File<input type="file" name="file" accept=".csv,text/csv"></label><div data-preview></div>',
      'Save all rows', function (data, dlg, errEl) {
        if (!entries) throw new Error('Choose a file first.');
        return API.call('uploadStock', { rows: entries }).then(function (r) {
          if (!r.ok) { showErrors(r.errors); throw new Error('Nothing was saved. Fix the rows above and upload again.'); }
          dlg.close(); toast('Saved ' + r.rows + ' row(s)'); done();
        });
      });
    var preview = $('[data-preview]', d), submit = $('button[type=submit]', d);
    submit.disabled = true;
    $('[data-tpl]', d).addEventListener('click', function () { downloadTemplate(items); });
    function showErrors(errors) {
      var bad = {}; errors.forEach(function (e) { bad[e.row] = e.error; });
      preview.innerHTML = '<div class="table-wrap" style="max-height:260px;margin-top:8px"><table><thead><tr><th>#</th><th>Material</th><th>Type</th><th class="num">Qty</th><th>Check</th></tr></thead><tbody>' +
        entries.map(function (e, i) {
          return '<tr><td>' + (i + 1) + '</td><td>' + esc(e.ItemName || e.ItemID) + '</td><td>' + esc(e.Type) + '</td><td class="num">' + esc(e.Qty) + '</td><td>' +
            (bad[i + 1] ? '<span class="pill bad">' + esc(bad[i + 1]) + '</span>' : '<span class="pill good">OK</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<p class="small ' + (errors.length ? 'warn-text' : 'muted') + '">' + (errors.length ? errors.length + ' row(s) need fixing.' : 'All ' + entries.length + ' rows are correct.') + '</p>';
    }
    $('[name=file]', d).addEventListener('change', function () {
      var f = this.files[0], alert = $('.alert', d);
      alert.classList.add('hidden'); entries = null; submit.disabled = true; preview.innerHTML = '';
      if (!f) return;
      if (/\.xlsx?$/i.test(f.name)) return showError(alert, new Error('Please save the Excel file as CSV first (File → Save As → CSV), then upload the CSV.'));
      var input = this;
      f.text().then(function (text) {
        // Clear the picker so choosing the same file again (after fixing it in Excel) is read again.
        input.value = '';
        entries = csvToEntries(parseCsv(text));
        preview.innerHTML = '<p class="muted small">Checking ' + entries.length + ' row(s)…</p>';
        return API.call('uploadStock', { rows: entries, dryRun: true });
      }).then(function (r) { if (!r) return; showErrors(r.errors); submit.disabled = !r.ok; })
        .catch(function (err) { entries = null; preview.innerHTML = ''; showError(alert, err); });
    });
  }

  function openConsumableRequest(items, itemId, done) {
    formDialog('Request material',
      '<label>Material<select name="ItemID" required>' + itemOptions(items, itemId) + '</select></label>' +
      '<div class="row"><label>Quantity<input name="Qty" type="number" step="any" min="0" required></label><label>Department<input name="Department" list="dept-list" required></label></div>' +
      '<label>Conveyor<input name="Conveyor" list="conv-list4"></label>' +
      '<label>Purpose<textarea name="Purpose" rows="2" required placeholder="e.g. Hot joint on CNV-205"></textarea></label><datalist id="conv-list4">' + convOptions() + '</datalist>',
      'Send request', function (data, dlg) {
        return API.call('raiseConsumableRequest', data).then(function (r) { dlg.close(); toast('Request ' + r.RequestNo + ' sent to the RTG team'); done(); });
      });
  }

  function renderConsumables(arg, params) {
    var tab = params.f === 'requests' ? 'requests' : 'items';
    var head = '<div class="page-head"><div><h1>Consumables</h1><p class="muted">Jointing material in the RTG Store: stock, expiry, consumption and requests.</p></div>' +
      '<div class="actions" style="margin:0">' + (isAdmin() ? '<button class="btn secondary" type="button" id="c-upload">Upload file</button><button class="btn secondary" type="button" id="c-entry">Update stock</button>' : '') +
      '<button class="btn" type="button" id="c-request">+ Request material</button></div></div>';
    view.innerHTML = '<div class="page-head"><div><h1>Consumables</h1></div></div><p class="muted">Loading…</p>';
    Promise.all([API.call('listConsumables'), API.call('listConsumableRequests')]).then(function (res) {
      var items = res[0], reqs = res[1];
      var reload = function () { renderConsumables(arg, params); };
      var waiting = reqs.filter(function (r) { return r.Status === 'Pending' || r.Status === 'Approved'; }).length;
      var count = function (fn) { return items.filter(fn).length; };
      function stat(label, v, tone, href) {
        return '<a class="card stat tile" href="' + href + '"><div class="label">' + esc(label) + '</div><div class="value"' + (tone && v ? ' style="color:var(--' + tone + ')"' : '') + '>' + v + '</div></a>';
      }
      var html = head +
        '<div class="grid grid-5" style="margin-bottom:16px">' +
        stat('Materials', items.length, '', '#/consumables') +
        stat('Low stock', count(function (i) { return i.lowStock; }), 'bad', '#/consumables?show=low') +
        stat('Expiring in 30 days', count(function (i) { return i.expiringSoon; }), 'warn', '#/consumables?show=expiring') +
        stat('Have expired stock', count(function (i) { return i.expiredQty > 0; }), 'bad', '#/consumables?show=expired') +
        stat('Requests to handle', waiting, 'warn', '#/consumables?f=requests') + '</div>' +
        '<div class="chips"><a class="chip' + (tab === 'items' ? ' active' : '') + '" href="#/consumables">Stock</a><a class="chip' + (tab === 'requests' ? ' active' : '') + '" href="#/consumables?f=requests">Requests' + (waiting ? ' (' + waiting + ')' : '') + '</a></div>';
      if (tab === 'items') {
        var show = params.show, list = items.filter(function (i) {
          return !show || (show === 'low' && i.lowStock) || (show === 'expiring' && i.expiringSoon) || (show === 'expired' && i.expiredQty > 0);
        });
        html += (show ? '<p class="small muted">Showing ' + esc({ low: 'low stock', expiring: 'expiring soon', expired: 'with expired stock' }[show]) + ' · <a href="#/consumables">show all</a></p>' : '') +
          '<div class="grid grid-3">' + (list.map(function (i) {
            var pills = [];
            if (i.lowStock) pills.push('<span class="pill bad">Low stock</span>');
            if (i.expiredQty > 0) pills.push('<span class="pill bad">' + esc(i.expiredQty) + ' expired</span>');
            if (i.expiringSoon) pills.push('<span class="pill warn">Expires ' + esc(i.nearestExpiry) + '</span>');
            if (!pills.length && i.stock > 0) pills.push('<span class="pill good">OK</span>');
            if (!i.stock) pills.push('<span class="pill none">No stock</span>');
            var diff = i.SAPStock !== '' && i.SAPStock !== undefined ? i.stock - Number(i.SAPStock) : null;
            return '<a class="card tile cons-card" href="#/consumable/' + encodeURIComponent(i.ItemID) + '">' +
              '<div><h2>' + esc(i.ItemName) + '</h2><div class="small muted">' + esc(i.Manufacturer || 'Manufacturer not set') + '</div></div>' +
              '<div class="cons-stock">' + esc(i.usableStock) + ' <span class="small muted">' + esc(i.Unit || '') + ' usable in store</span></div>' +
              '<div>' + pills.join(' ') + '</div>' +
              '<div class="kv"><span>This month <b>' + esc(i.thisMonth) + '</b></span><span>Avg / month <b>' + esc(i.avgMonthly) + '</b></span>' +
              '<span>SAP <b>' + esc(i.SAPStock === '' ? '—' : i.SAPStock) + '</b>' + (diff ? ' <span class="' + (diff ? 'warn-text' : '') + '">(' + (diff > 0 ? '+' : '') + diff + ')</span>' : '') + '</span>' +
              (i.monthsCover !== null ? '<span>Lasts <b>' + esc(i.monthsCover) + ' mo</b></span>' : '') + '</div></a>';
          }).join('') || '<div class="card"><p class="muted">Nothing here.</p></div>') + '</div>';
      } else {
        html += '<div class="card"><div class="table-wrap"><table><thead><tr><th>Request</th><th>Ticket</th><th>Material</th><th class="num">Qty</th><th>Department / conveyor</th><th>Purpose</th><th>Status</th>' + (isAdmin() ? '<th></th>' : '') + '</tr></thead><tbody>' +
          (reqs.map(function (r) {
            var act = '';
            if (isAdmin() && r.Status === 'Pending') act = '<button class="btn small" data-approve="' + esc(r.RequestNo) + '" type="button">Approve</button> <button class="btn small danger" data-reject="' + esc(r.RequestNo) + '" type="button">Reject</button>';
            if (isAdmin() && r.Status === 'Approved') act = '<button class="btn small" data-issue="' + esc(r.RequestNo) + '" type="button">Issue</button>';
            return '<tr><td><b>' + esc(r.RequestNo) + '</b><div class="small muted">' + esc(r.RaisedOn) + ' · ' + esc(r.RaisedByName) + '</div></td><td>' + esc(r.TicketNo || '—') + '</td><td>' + esc(r.ItemName) + '</td><td class="num">' + qtyText(r.IssuedQty || r.Qty, r.Unit) + '</td>' +
              '<td>' + esc(r.Department) + '<div class="small muted">' + esc(r.Conveyor) + '</div></td><td>' + esc(r.Purpose) + (r.RejectReason ? '<div class="small" style="color:var(--bad)">Rejected: ' + esc(r.RejectReason) + '</div>' : '') +
              (r.IssuedBatch ? '<div class="small muted">Batch ' + esc(r.IssuedBatch) + '</div>' : '') + '</td>' +
              '<td><span class="pill ' + (CREQ_PILL[r.Status] || 'info') + '">' + esc(r.Status) + '</span></td>' + (isAdmin() ? '<td style="white-space:nowrap">' + act + '</td>' : '') + '</tr>';
          }).join('') || '<tr><td colspan="8" class="muted">No consumable requests yet.</td></tr>') + '</tbody></table></div></div>';
      }
      view.innerHTML = html;
      $('#c-request').addEventListener('click', function () { openConsumableRequest(items, '', function () { location.hash = '#/consumables?f=requests'; reload(); }); });
      if (isAdmin()) {
        $('#c-entry').addEventListener('click', function () { openStockEntry(items, '', reload); });
        $('#c-upload').addEventListener('click', function () { openUpload(items, reload); });
      }
      view.querySelectorAll('[data-approve]').forEach(function (b) {
        b.addEventListener('click', function () {
          busy(b, true);
          API.call('decideConsumableRequest', { RequestNo: b.dataset.approve, decision: 'approve' })
            .then(function (r) { toast('Approved. Ticket ' + r.TicketNo); reload(); }).catch(function (err) { toast(err.message); busy(b, false); });
        });
      });
      view.querySelectorAll('[data-reject]').forEach(function (b) {
        b.addEventListener('click', function () {
          formDialog('Reject ' + b.dataset.reject, '<label>Reason (sent to the person who asked)<textarea name="reason" rows="3" required></textarea></label>', 'Reject', function (data, dlg) {
            return API.call('decideConsumableRequest', { RequestNo: b.dataset.reject, decision: 'reject', reason: data.reason }).then(function () { dlg.close(); toast('Rejected'); reload(); });
          });
        });
      });
      view.querySelectorAll('[data-issue]').forEach(function (b) {
        var r = reqs.filter(function (x) { return x.RequestNo === b.dataset.issue; })[0];
        b.addEventListener('click', function () {
          formDialog('Issue ' + r.TicketNo, '<p class="muted small">' + esc(r.ItemName) + ' for ' + esc(r.Department) + '. Stock is taken from the batch that expires first unless you name one.</p>' +
            '<div class="row"><label>Quantity handed over<input name="Qty" type="number" step="any" min="0" required value="' + esc(r.Qty) + '"></label><label>Batch (optional)<input name="BatchNo"></label></div>', 'Issue', function (data, dlg) {
            data.no = r.RequestNo;
            return API.call('issueConsumable', data).then(function (x) { dlg.close(); toast('Issued from batch ' + x.batches.join(', ')); reload(); });
          });
        });
      });
    }).catch(handleError);
  }

  function renderConsumable(id) {
    view.innerHTML = '<p class="muted">Loading…</p>';
    Promise.all([API.call('consumableDetail', { ItemID: id }), API.call('listConsumables')]).then(function (res) {
      var d = res[0], items = res[1], s = d.summary;
      var reload = function () { renderConsumable(id); };
      var diff = s.SAPStock !== '' ? s.stock - Number(s.SAPStock) : null;
      view.innerHTML =
        '<div class="page-head"><div><h1>' + esc(s.ItemName) + '</h1><p class="muted">' + esc(s.Manufacturer || 'Manufacturer not set') + (s.Unit ? ' · unit: ' + esc(s.Unit) : '') + '</p></div>' +
        '<div class="actions" style="margin:0"><a class="btn secondary" href="#/consumables">Back</a>' + (isAdmin() ? '<button class="btn secondary" id="i-edit" type="button">Edit details</button><button class="btn secondary" id="i-entry" type="button">Update stock</button>' : '') +
        '<button class="btn" id="i-request" type="button">Request this</button></div></div>' +
        '<div class="grid grid-5" style="margin-bottom:16px">' +
        statTile('Usable stock', s.usableStock + (s.Unit ? ' ' + s.Unit : ''), true) +
        statTile('Expired stock', s.expiredQty) +
        statTile('Used this month', s.thisMonth) +
        statTile('Average per month (6 mo)', s.avgMonthly) +
        statTile('SAP stock' + (diff ? ' (diff ' + (diff > 0 ? '+' : '') + diff + ')' : ''), s.SAPStock === '' ? '—' : s.SAPStock) + '</div>' +
        (s.lowStock ? '<div class="alert error">Stock is at or below the reorder level (' + esc(s.ReorderLevel) + ').</div>' : '') +
        '<div class="card"><h2>Monthly consumption</h2><div class="chart-box" style="height:240px"><canvas id="chart-monthly" aria-label="Monthly consumption, last 12 months"></canvas></div></div>' +
        '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">' +
        '<div class="card"><h2>Department-wise (last 6 months)</h2><div class="table-wrap"><table><thead><tr><th>Department</th>' + d.deptMonths.map(function (m) { return '<th class="num">' + MONTHS[Number(m.slice(5)) - 1] + '</th>'; }).join('') + '<th class="num">Total 12 mo</th></tr></thead><tbody>' +
        (d.deptMonthly.map(function (r, i) { return '<tr><td>' + esc(r.department) + '</td>' + r.months.map(function (v) { return '<td class="num">' + (v || '<span class="muted">0</span>') + '</td>'; }).join('') + '<td class="num"><b>' + d.byDepartment[i].qty + '</b></td></tr>'; }).join('') ||
          '<tr><td colspan="8" class="muted">No consumption recorded yet.</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><h2>Stock by batch</h2><div class="table-wrap"><table><thead><tr><th>Batch</th><th class="num">Qty</th><th>Expiry</th><th>Received</th></tr></thead><tbody>' +
        (d.batches.map(function (b) {
          var tag = b.expired ? '<span class="pill bad">Expired</span>' : b.daysLeft !== null && b.daysLeft <= 30 ? '<span class="pill warn">' + b.daysLeft + ' days left</span>' : '';
          return '<tr><td><b>' + esc(b.BatchNo) + '</b></td><td class="num">' + esc(b.Qty) + '</td><td>' + esc(b.ExpiryDate || '—') + ' ' + tag + '</td><td>' + esc(b.ReceivedOn) + '</td></tr>';
        }).join('') || '<tr><td colspan="4" class="muted">No stock.</td></tr>') + '</tbody></table></div></div></div>' +
        '<div class="card" style="margin-top:16px"><h2>Recent movements</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th class="num">Qty</th><th>Batch</th><th>Department / conveyor</th><th>Ref</th><th>By</th></tr></thead><tbody>' +
        (d.transactions.map(function (t) {
          return '<tr><td>' + esc(t.Date) + '</td><td><span class="pill ' + (t.Type === 'Issue' ? 'info' : t.Type === 'Receipt' ? 'good' : 'warn') + '">' + esc(t.Type) + '</span></td><td class="num">' + esc(t.Qty) + '</td><td>' + esc(t.BatchNo) + '</td><td>' + esc(t.Department) + '<div class="small muted">' + esc(t.Conveyor) + '</div></td><td>' + esc(t.Ref) + '</td><td>' + esc(t.EnteredBy) + '</td></tr>';
        }).join('') || '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>') + '</tbody></table></div></div>';
      drawMonthly(d.monthly, s.avgMonthly);
      $('#i-request').addEventListener('click', function () { openConsumableRequest(items, id, function () { location.hash = '#/consumables?f=requests'; }); });
      if (isAdmin()) {
        $('#i-entry').addEventListener('click', function () { openStockEntry(items, id, reload); });
        $('#i-edit').addEventListener('click', function () {
          formDialog('Edit ' + s.ItemName,
            '<div class="row"><label>Manufacturer<input name="Manufacturer" value="' + esc(s.Manufacturer) + '"></label><label>Unit<input name="Unit" value="' + esc(s.Unit) + '" placeholder="kit, kg, litre, roll"></label></div>' +
            '<div class="row"><label>Reorder level<input name="ReorderLevel" type="number" step="any" value="' + esc(s.ReorderLevel) + '"></label><label>SAP stock<input name="SAPStock" type="number" step="any" value="' + esc(s.SAPStock) + '"></label></div>',
            'Save', function (data, dlg) {
              data.ItemID = id;
              return API.call('saveConsumable', data).then(function () { dlg.close(); toast('Saved'); reload(); });
            });
        });
      }
    }).catch(function (err) {
      if (err.auth) return handleError(err);
      view.innerHTML = '<div class="card"><h2>Not found</h2><p class="muted">' + esc(err.message) + '</p><a class="btn" href="#/consumables">Back</a></div>';
    });
  }

  function drawMonthly(monthly, avg) {
    if (!window.Chart) return;
    var text2 = cssVar('--text-2'), grid = cssVar('--border');
    charts.push(new Chart($('#chart-monthly'), {
      type: 'bar',
      data: {
        labels: monthly.map(function (m) { return MONTHS[Number(m.month.slice(5)) - 1] + ' ' + m.month.slice(2, 4); }),
        datasets: [
          { label: 'Issued', data: monthly.map(function (m) { return m.qty; }), backgroundColor: cssVar('--series-1'), borderRadius: 4, maxBarThickness: 36 },
          { label: 'Average (6 mo)', type: 'line', data: monthly.map(function () { return avg; }), borderColor: cssVar('--series-2'), borderDash: [6, 4], borderWidth: 2, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: text2, boxWidth: 12 } }, tooltip: { mode: 'index', intersect: false } },
        scales: { x: { grid: { display: false }, ticks: { color: text2 } }, y: { beginAtZero: true, ticks: { precision: 0, color: text2 }, grid: { color: grid } } }
      }
    }));
  }

  // ---------- heater maintenance (vendor logs, RTG verifies) ----------
  function canMaintain() { return isAdmin() || (state.user && state.user.Team === 'Vendor'); }
  var MLOG_PILL = { Submitted: 'warn', Verified: 'good', Rejected: 'bad' };

  // Photos are shrunk before upload so they go up quickly over mobile data. PDFs go as they are.
  function readChecklist(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('Attach the filled checklist (photo or PDF).'));
      var isPdf = file.type === 'application/pdf';
      if (!isPdf && !/^image\//.test(file.type)) return reject(new Error('The checklist must be a photo or a PDF.'));
      if (isPdf && file.size > 6 * 1024 * 1024) return reject(new Error('The PDF is too big. Please keep it under 6 MB.'));
      var rd = new FileReader();
      rd.onerror = function () { reject(new Error('Could not read the file.')); };
      rd.onload = function () {
        if (isPdf) return resolve({ name: file.name, type: file.type, data: String(rd.result).split(',')[1] });
        var img = new Image();
        img.onerror = function () { reject(new Error('Could not open the photo. Try a JPG or PNG.')); };
        img.onload = function () {
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve({ name: file.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.75).split(',')[1] });
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }

  function openChecklist(logNo, btn) {
    busy(btn, true);
    // Open the tab now (browsers block pop-ups opened after a wait), then fill it.
    var win = window.open('', '_blank');
    API.call('getChecklist', { LogNo: logNo }).then(function (f) {
      var bytes = atob(f.data), arr = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([arr], { type: f.type }));
      if (win) win.location = url; else location.href = url;
    }).catch(function (err) { if (win) win.close(); toast(err.message); }).then(function () { busy(btn, false); });
  }

  function renderMaintenance(arg, params) {
    if (!canMaintain()) { view.innerHTML = '<div class="card"><h2>Maintenance</h2><p class="muted">This page is for the RTG team and the maintenance vendor.</p></div>'; return; }
    var show = params.f || (isAdmin() ? 'verify' : 'log');
    view.innerHTML = '<div class="page-head"><div><h1>Heater maintenance</h1></div></div><p class="muted">Loading…</p>';
    Promise.all([API.call('maintenanceDue'), API.call('listMaintenanceLogs')]).then(function (res) {
      var due = res[0], logs = res[1];
      var reload = function (msg) { if (msg) toast(msg); renderMaintenance(arg, params); };
      var waiting = logs.filter(function (l) { return l.Status === 'Submitted'; });
      var month = todayStr().slice(0, 7);
      var free = due.filter(function (c) { return !c.pendingLog; });
      function stat(label, v, tone, f) {
        return '<a class="card stat tile' + (show === f ? ' accent' : '') + '" href="#/maintenance?f=' + f + '"><div class="label">' + esc(label) + '</div><div class="value"' + (tone && v ? ' style="color:var(--' + tone + ')"' : '') + '>' + v + '</div></a>';
      }
      var html = '<div class="page-head"><div><h1>Heater maintenance</h1><p class="muted">After every joint, parts come back "maintenance due". The vendor logs the maintenance with the checklist, RTG verifies, and the parts are ready to issue again.</p></div></div>' +
        '<div class="grid grid-5" style="margin-bottom:16px">' +
        stat('Parts due after a joint', free.filter(function (c) { return c.due; }).length, 'warn', 'log') +
        stat('Logs waiting for RTG check', waiting.length, 'warn', 'verify') +
        stat('Verified this month', logs.filter(function (l) { return l.Status === 'Verified' && String(l.VerifiedOn).slice(0, 7) === month; }).length, '', 'all') + '</div>' +
        '<div class="chips">' + [['log', 'Log maintenance'], ['verify', 'Waiting for RTG check' + (waiting.length ? ' (' + waiting.length + ')' : '')], ['all', 'All logs']].map(function (c) {
          return '<a class="chip' + (show === c[0] ? ' active' : '') + '" href="#/maintenance?f=' + c[0] + '">' + esc(c[1]) + '</a>';
        }).join('') + '</div>';

      if (show === 'log') {
        // Group the parts by heater set so a whole set can be ticked at once. Sets due after a joint come first.
        var groups = {}, order = [];
        free.forEach(function (c) {
          var k = c.ModelName + (c.SetNo ? ' · set ' + c.SetNo : '');
          if (!groups[k]) { groups[k] = []; order.push(k); }
          groups[k].push(c);
        });
        var isDue = function (k) { return groups[k].some(function (c) { return c.due; }); };
        order.sort(function (a, b) { return (isDue(b) - isDue(a)) || a.localeCompare(b, undefined, { numeric: true }); });
        var firstRoutine = order.filter(function (k) { return !isDue(k); })[0];
        var lastDone = function (k) { return groups[k].map(function (c) { return String(c.LastInspected || ''); }).sort()[0] || ''; };
        html += free.length ? '<form id="form-mlog" class="stack">' +
          '<div class="card stack"><h2>1. Which parts did you maintain?</h2><p class="muted small">Tick a whole set, or open it to tick single parts. Heaters back from a joint are at the top; every other heater in the store is below for routine maintenance.</p>' +
          (isDue(order[0]) ? '' : '<p class="small muted">No heater is due after a joint right now.</p>') +
          order.map(function (k, gi) {
            var tag = isDue(k) ? '<span class="pill warn">Due after joint</span>' : '<span class="pill none">Last maintained ' + esc(lastDone(k) || 'not recorded') + '</span>';
            return (k === firstRoutine ? '<h3 class="small muted" style="margin:10px 0 0;text-transform:uppercase;letter-spacing:.04em">Other heaters in store: routine maintenance</h3>' : '') +
              '<details class="mset"><summary><span class="mset-head"><input type="checkbox" data-group="' + gi + '" style="min-height:auto"> <b>' + esc(k) + '</b> ' + tag + ' <span class="muted small">' + groups[k].length + ' part(s)</span></span></summary>' +
              '<div class="table-wrap"><table><tbody>' + groups[k].map(function (c) {
                var damaged = c.Condition !== 'OK';
                return '<tr><td style="width:36px"><input type="checkbox" data-part="' + esc(c.ComponentID) + '" data-g="' + gi + '" style="min-height:auto"></td><td><b>' + esc(c.ComponentID) + '</b></td><td>' + esc(c.ComponentName) +
                  (c.Remarks ? '<div class="small muted">' + esc(c.Remarks) + '</div>' : '') + '</td><td>' +
                  (damaged ? '<span class="pill bad">' + esc(c.Condition) + '</span> <label class="small" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-repaired="' + esc(c.ComponentID) + '" style="min-height:auto"> Repaired</label>' : '<span class="pill good">OK</span>') +
                  '</td><td class="num small muted">' + esc(c.JointsSinceMaintenance) + ' joint(s)</td></tr>';
              }).join('') + '</tbody></table></div></details>';
          }).join('') + '</div>' +
          '<div class="card stack"><h2>2. What did you do?</h2><div class="row"><label>Date<input type="date" name="LogDate" required value="' + todayStr() + '" max="' + todayStr() + '"></label>' +
          '<label>Vendor team<input name="VendorTeam" value="' + esc(state.user.Department || '') + '"></label></div>' +
          '<label>Work done<textarea name="WorkDone" rows="3" required placeholder="e.g. Cleaned platens, checked thermocouples and cables, replaced 2 bolts"></textarea></label></div>' +
          '<div class="card stack"><h2>3. Attach the filled checklist</h2><p class="muted small">Take a clear photo of the signed checklist, or attach a PDF.</p>' +
          '<label>Checklist<input type="file" name="file" accept="image/*,application/pdf" required></label></div>' +
          '<div class="alert error hidden" id="mlog-error"></div><div class="actions"><span class="muted small" id="mlog-count">0 parts selected</span><button class="btn" type="submit">Send to RTG for checking</button></div></form>'
          : '<div class="card"><p class="muted">No heater parts are in the store right now, or every part is already in a log waiting for RTG.</p></div>';
      } else {
        var list = show === 'verify' ? waiting : logs;
        html += '<div class="stack">' + (list.map(function (l) {
          return '<div class="card stack"><div class="model-head"><div><h2>' + esc(l.LogNo) + ' · ' + esc(l.LogDate) + '</h2><div class="small muted">Logged by ' + esc(l.LoggedByName) + (l.VendorTeam ? ' (' + esc(l.VendorTeam) + ')' : '') + ' on ' + esc(l.LoggedOn) + '</div></div>' +
            '<span class="pill ' + (MLOG_PILL[l.Status] || 'info') + '">' + esc(l.Status === 'Submitted' ? 'Waiting for RTG check' : l.Status) + '</span></div>' +
            '<p>' + esc(l.WorkDone) + '</p>' +
            '<div class="kv">' + l.parts.map(function (p) { return '<span><b>' + esc(p.ComponentID) + '</b> ' + esc(p.ComponentName) + (l.repaired.indexOf(p.ComponentID) >= 0 ? ' <span class="pill good">repaired</span>' : '') + '</span>'; }).join('') + '</div>' +
            (l.RTGRemark ? '<p class="small"><b>RTG:</b> ' + esc(l.RTGRemark) + (l.VerifiedBy ? ' <span class="muted">(' + esc(l.VerifiedBy) + ', ' + esc(l.VerifiedOn) + ')</span>' : '') + '</p>' : '') +
            '<div class="actions" style="justify-content:flex-start"><button class="btn secondary small" type="button" data-checklist="' + esc(l.LogNo) + '">View checklist</button>' +
            (isAdmin() && l.Status === 'Submitted' ? '<span style="flex:1"></span><button class="btn small danger" type="button" data-mreject="' + esc(l.LogNo) + '">Not OK</button><button class="btn small" type="button" data-mapprove="' + esc(l.LogNo) + '">Verified, ready to issue</button>' : '') +
            '</div></div>';
        }).join('') || '<div class="card"><p class="muted">Nothing here.</p></div>') + '</div>';
      }
      view.innerHTML = html;

      view.querySelectorAll('[data-checklist]').forEach(function (b) { b.addEventListener('click', function () { openChecklist(b.dataset.checklist, b); }); });
      view.querySelectorAll('[data-mapprove]').forEach(function (b) {
        b.addEventListener('click', function () {
          busy(b, true);
          API.call('verifyMaintenance', { LogNo: b.dataset.mapprove, decision: 'approve' }).then(function (r) { reload(r.parts + ' part(s) are ready to issue again'); })
            .catch(function (err) { toast(err.message); busy(b, false); });
        });
      });
      view.querySelectorAll('[data-mreject]').forEach(function (b) {
        b.addEventListener('click', function () {
          formDialog('Not OK: ' + b.dataset.mreject, '<label>What is wrong (mailed to the vendor)<textarea name="remark" rows="3" required></textarea></label>', 'Send back to vendor', function (data, dlg) {
            return API.call('verifyMaintenance', { LogNo: b.dataset.mreject, decision: 'reject', remark: data.remark }).then(function () { dlg.close(); reload('Sent back to the vendor'); });
          });
        });
      });
      var form = $('#form-mlog');
      if (form) {
        var count = function () {
          var n = form.querySelectorAll('[data-part]:checked').length;
          $('#mlog-count').textContent = n + ' part' + (n === 1 ? '' : 's') + ' selected';
          form.querySelectorAll('[data-group]').forEach(function (g) {
            var parts = form.querySelectorAll('[data-g="' + g.dataset.group + '"]'), on = form.querySelectorAll('[data-g="' + g.dataset.group + '"]:checked').length;
            g.checked = on === parts.length; g.indeterminate = on > 0 && on < parts.length;
          });
        };
        form.addEventListener('change', function (e) {
          if (e.target.dataset.group !== undefined) form.querySelectorAll('[data-g="' + e.target.dataset.group + '"]').forEach(function (x) { x.checked = e.target.checked; });
          if (e.target.dataset.repaired && e.target.checked) { var p = form.querySelector('[data-part="' + e.target.dataset.repaired + '"]'); if (p) p.checked = true; }
          count();
        });
        // Ticking the set box shouldn't also open/close it.
        form.querySelectorAll('.mset-head input').forEach(function (x) { x.addEventListener('click', function (e) { e.stopPropagation(); }); });
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var btn = $('button[type=submit]', form), fd = formData(form);
          var ids = Array.prototype.map.call(form.querySelectorAll('[data-part]:checked'), function (x) { return x.dataset.part; });
          var repaired = Array.prototype.map.call(form.querySelectorAll('[data-repaired]:checked'), function (x) { return x.dataset.repaired; });
          if (!ids.length) return showError($('#mlog-error'), new Error('Tick the parts you maintained.'));
          busy(btn, true);
          readChecklist(form.file.files[0]).then(function (file) {
            return API.call('logMaintenance', { ComponentIDs: ids, RepairedIDs: repaired, LogDate: fd.LogDate, VendorTeam: fd.VendorTeam, WorkDone: fd.WorkDone, file: file });
          }).then(function (r) { location.hash = '#/maintenance?f=all'; toast('Log ' + r.LogNo + ' sent to RTG for checking'); })
            .catch(function (err) { showError($('#mlog-error'), err); busy(btn, false); });
        });
      }
    }).catch(handleError);
  }

  // ---------- users (admin) ----------
  function renderUsers() {
    view.innerHTML = '<div class="page-head"><div><h1>Users</h1><p class="muted">Choose who is an admin or approver. New users get a temporary password.</p></div><button class="btn" id="add-user" type="button">+ Add user</button></div><div class="card"><p class="muted">Loading…</p></div>';
    $('#add-user').addEventListener('click', function () { openUser(null); });
    API.call('listUsers').then(function (users) {
      state.users = users;
      $('.card', view).innerHTML = '<div class="table-wrap"><table><thead><tr><th>User ID</th><th>Name</th><th>Employee ID</th><th>Role</th><th>Team</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>' +
        users.map(function (u, i) {
          return '<tr><td><b>' + esc(u.UserID) + '</b></td><td>' + esc(u.Name) + '</td><td>' + esc(u.EmployeeID) + '</td><td>' +
            '<span class="pill ' + (u.Role === 'Admin' ? 'info' : u.Role === 'Local' ? 'good' : 'warn') + '">' + esc(u.Role) + '</span></td><td>' + esc(u.Team) + '</td><td>' + esc(u.Email) + '</td><td>' +
            (String(u.Active) === 'true' || u.Active === true ? 'Active' : '<span class="muted">Disabled</span>') + '</td><td style="white-space:nowrap">' +
            '<button class="btn secondary small" data-edit="' + i + '" type="button">Edit</button> <button class="btn secondary small" data-reset="' + i + '" type="button">Reset password</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      view.addEventListener('click', onUserClick);
    }).catch(handleError);
  }

  function onUserClick(e) {
    var b = e.target.closest('button');
    if (!b || !state.users) return;
    if (b.dataset.edit) openUser(state.users[b.dataset.edit]);
    if (b.dataset.reset) {
      var u = state.users[b.dataset.reset];
      if (!confirm('Reset the password for ' + u.Name + '?')) return;
      API.call('resetPassword', { UserID: u.UserID }).then(function (r) { showTempPassword(u.UserID, r.tempPassword); }).catch(function (err) { toast(err.message); });
    }
  }

  function showTempPassword(userId, pw) {
    var d = document.createElement('dialog');
    d.innerHTML = '<h2>Temporary password</h2><p>Give this to <b>' + esc(userId) + '</b>. They will be asked to change it when they log in.</p><p><code class="pw">' + esc(pw) + '</code></p><div class="actions"><button class="btn" type="button">Done</button></div>';
    document.body.appendChild(d);
    $('button', d).addEventListener('click', function () { d.close(); d.remove(); });
    d.showModal();
  }

  function openUser(u) {
    var dlg = $('#dlg-user'), f = $('#form-user');
    f.reset();
    $('#user-error').classList.add('hidden');
    $('#user-title').textContent = u ? 'Edit ' + u.Name : 'Add user';
    f.UserID.readOnly = !!u;
    if (u) ['UserID', 'Name', 'EmployeeID', 'Email', 'Role', 'Team', 'Department', 'Phone'].forEach(function (k) { f[k].value = u[k] || ''; });
    f.Active.checked = !u || String(u.Active) === 'true' || u.Active === true;
    dlg.showModal();
  }

  $('#user-cancel').addEventListener('click', function () { $('#dlg-user').close(); });
  $('#form-user').addEventListener('submit', function (e) {
    e.preventDefault();
    var data = formData(e.target), btn = $('button[type=submit]', e.target);
    busy(btn, true);
    API.call('saveUser', data).then(function (r) {
      $('#dlg-user').close();
      if (r.tempPassword) showTempPassword(data.UserID, r.tempPassword); else toast('Saved');
      view.removeEventListener('click', onUserClick);
      renderUsers();
    }).catch(function (err) { showError($('#user-error'), err); }).then(function () { busy(btn, false); });
  });

  // ---------- password ----------
  function openPassword(forced) {
    var dlg = $('#dlg-password');
    $('#form-password').reset();
    $('#pw-error').classList.add('hidden');
    $('#pw-reason').textContent = forced ? 'You are using a temporary password. Please set your own to continue.' : '';
    $('#pw-cancel').classList.toggle('hidden', !!forced);
    dlg.dataset.forced = forced ? '1' : '';
    dlg.showModal();
  }
  $('#dlg-password').addEventListener('cancel', function (e) { if (this.dataset.forced) e.preventDefault(); });
  $('#pw-cancel').addEventListener('click', function () { $('#dlg-password').close(); });
  $('#btn-password').addEventListener('click', function () { openPassword(false); });
  $('#form-password').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = formData(e.target);
    if (f.newPassword !== f.repeat) return showError($('#pw-error'), new Error('The new passwords do not match.'));
    API.call('changePassword', { oldPassword: f.oldPassword, newPassword: f.newPassword }).then(function () {
      state.user.MustChangePassword = false;
      $('#dlg-password').close();
      toast('Password changed');
    }).catch(function (err) { showError($('#pw-error'), err); });
  });

  $('#btn-logout').addEventListener('click', function () {
    API.logout();
    state.user = null;
    location.hash = '#/login';
  });

  // ---------- start ----------
  if (API.demo) $('#demo-banner').classList.remove('hidden');
  window.addEventListener('hashchange', function () {
    view.removeEventListener('click', onUserClick);
    route();
  });
  if (API.token) {
    API.call('me').then(function (d) { state.user = d.user; afterLogin(); }).catch(function () { API.logout(); renderLogin(); });
  } else {
    renderLogin();
  }
})();
