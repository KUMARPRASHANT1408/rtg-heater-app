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
    { hash: '#/requests', label: 'Requests & tickets' },
    { hash: '#/transfers', label: 'Site transfers' },
    { hash: '#/inventory', label: 'Heater inventory', admin: true },
    { hash: '#/users', label: 'Users', admin: true }
  ];
  var ROUTES = { '#/home': renderHome, '#/heaters': renderHeaters, '#/inventory': renderInventory, '#/users': renderUsers,
                 '#/requests': renderRequests, '#/request': renderNewRequest, '#/ticket': renderTicket, '#/transfers': renderTransfers };
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
    renderChrome(h.base === '#/ticket' || h.base === '#/request' ? '#/requests' : h.base);
    (ROUTES[h.base] || renderHome)(h.arg, h.params);
  }

  function renderChrome(hash) {
    $('#topbar').classList.remove('hidden');
    $('#who-name').textContent = state.user.Name;
    $('#who-role').textContent = state.user.Role;
    $('#nav').innerHTML = NAV.filter(function (n) { return !n.admin || isAdmin(); }).map(function (n) {
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
      { href: '#/consumables', ico: '🧪', title: 'Consumables', text: 'Stock, expiry, monthly and department-wise consumption, and requests.', soon: true }
    ];
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
        t('Overdue', d.overdue, 'overdue', 'bad') + t('Open issues', d.openIssues, 'issue', 'bad');
    }).catch(function () { box.remove(); });
  }

  // ---------- heater search ----------
  function renderHeaters() {
    var conv = (state.lookups && state.lookups.conveyors) || [];
    view.innerHTML =
      '<div class="page-head"><div><h1>Find a suitable heater</h1><p class="muted">Pick a conveyor or type the belt details.</p></div></div>' +
      '<form class="card" id="form-search"><div class="row">' +
      '<label>Conveyor (optional)<select name="conveyor"><option value="">Choose to auto-fill</option>' +
      conv.map(function (c) { return '<option value="' + esc(c.ConveyorName) + '">' + esc(c.ConveyorName) + (c.Area ? ' · ' + esc(c.Area) : '') + '</option>'; }).join('') +
      '</select></label>' +
      '<label>Belt width (mm)<input name="width" type="number" min="1" required inputmode="numeric"></label>' +
      '<label>Belt rating (N/mm)<input name="rating" type="number" min="1" required inputmode="numeric"></label>' +
      '<label>No. of plies<input name="plies" type="number" min="1" inputmode="numeric"></label>' +
      '<button class="btn" type="submit">Show heaters</button>' +
      '</div></form><div id="results" class="stack" style="margin-top:20px"></div>';
    var form = $('#form-search');
    form.conveyor.addEventListener('change', function () {
      var c = conv.filter(function (x) { return x.ConveyorName === form.conveyor.value; })[0];
      if (!c) return;
      form.width.value = c.BeltWidth_mm || ''; form.rating.value = c.BeltRating_Nmm || ''; form.plies.value = c.Plies || '';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = formData(form), btn = $('button', form);
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
      el.innerHTML = html + '<div class="card"><h2>No suitable heater</h2><p class="muted">No heater model covers a ' + esc(r.query.width) + ' mm belt at ' + esc(r.query.rating) + ' N/mm' + (r.query.plies ? ' with ' + esc(r.query.plies) + ' plies' : '') + '. Contact the RTG Store.</p></div>';
      return;
    }
    html += '<div class="card"><h2>Suitable heater sets</h2>' +
      '<div class="legend" style="margin:6px 0 10px"><span><i style="background:var(--series-1)"></i>Ready to issue</span><span><i style="background:var(--series-2)"></i>Out on site</span><span><i style="background:var(--series-muted)"></i>Not usable (damaged, missing or maintenance due)</span></div>' +
      '<div class="chart-box" style="height:' + Math.max(140, 56 * r.suitable.length + 50) + 'px"><canvas id="chart-sets" aria-label="Heater sets by status"></canvas></div></div>';

    html += r.suitable.map(function (s) {
      var m = s.model, notUsable = Math.max(0, s.totalSets - s.availableSets - s.deployedCount);
      var total = Math.max(1, s.totalSets);
      return '<div class="card model-card">' +
        '<div class="model-head"><div><h2>' + esc(m.ModelName) + '</h2><div class="kv">' +
        '<span>Width <b>' + esc(m.BeltWidthMin_mm) + '–' + esc(m.BeltWidthMax_mm) + ' mm</b></span>' +
        (m.RatingMax_Nmm ? '<span>Rating up to <b>' + esc(m.RatingMax_Nmm) + ' N/mm</b></span>' : '') +
        (m.PliesMax ? '<span>Plies up to <b>' + esc(m.PliesMax) + '</b></span>' : '') +
        '</div></div>' +
        (s.availableSets > 0 ? '<span class="pill good">✓ ' + s.availableSets + ' ready to issue</span>' : '<span class="pill bad">✕ None ready</span>') +
        '</div>' +
        '<div class="meter" role="img" aria-label="' + s.availableSets + ' ready, ' + s.deployedCount + ' out, ' + notUsable + ' not usable">' +
        '<span style="width:' + (100 * s.availableSets / total) + '%;background:var(--series-1)"></span>' +
        '<span style="width:' + (100 * s.deployedCount / total) + '%;background:var(--series-2)"></span>' +
        '<span style="width:' + (100 * notUsable / total) + '%;background:var(--series-muted)"></span></div>' +
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
          var pill = !cond ? '<span class="pill info">On site</span>' : cond === 'OK' ? '<span class="pill good">OK</span>' : '<span class="pill bad">' + esc(cond) + '</span>';
          return '<tr><td><b>' + esc(i.ComponentID) + '</b></td><td>' + esc(i.ComponentName) + (i.Remarks ? '<div class="small muted">' + esc(i.Remarks) + '</div>' : '') + '</td><td class="num">' + esc(i.QtyOut) + '</td><td>' + pill + '</td></tr>';
        }).join('') + '</tbody></table></div>' :
        '<div class="table-wrap"><table><thead><tr><th>Component</th><th class="num">Qty</th></tr></thead><tbody>' +
        r.RequestedComponents.map(function (c) { return '<tr><td>' + esc(c.name) + '</td><td class="num">' + esc(c.qty) + '</td></tr>'; }).join('') + '</tbody></table></div>') +
      '</div></div>';

    if (d.issues.length) {
      html += '<div class="card stack" style="margin-top:16px"><h2>Issues</h2>' + d.issues.map(function (i) {
        var parts = [];
        try { parts = JSON.parse(i.AffectedComponents || '[]'); } catch (e) {}
        return '<div class="issue"><div class="model-head"><b>' + esc(i.IssueNo) + '</b>' + (i.Status === 'Closed' ? '<span class="pill good">Closed</span>' : '<span class="pill bad">Open</span>') + '</div>' +
          '<p>' + esc(i.Description) + '</p><p class="small muted">' + parts.map(function (p) { return esc(p.id) + ' ' + esc(p.name) + ': ' + esc(p.result) + (p.remarks ? ' (' + esc(p.remarks) + ')' : ''); }).join(' · ') + '</p>' +
          (i.FMExplanation ? '<p class="small"><b>FM explanation:</b> ' + esc(i.FMExplanation) + '</p>' : '') +
          (isAdmin() && i.Status !== 'Closed' ? '<form class="row" data-issue="' + esc(i.IssueNo) + '"><label>FM explanation received<textarea name="explanation" rows="2" required></textarea></label><div><button class="btn" type="submit">Record &amp; close issue</button></div></form>' : '') +
          '</div>';
      }).join('') + '</div>';
    }

    html += transferSection(d, status);
    if (isAdmin()) html += adminPanel(d, status, outstanding);
    view.innerHTML = html;
    wireTicket(d, outstanding);
    wireTransferSection(d, function (msg) { if (msg) toast(msg); renderTicket(d.ticket.TicketNo); });
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
        '<p class="muted small">Check every component. Anything not marked comes back later and keeps the ticket open.</p>' +
        '<form id="form-return" class="stack"><div class="actions" style="justify-content:flex-start"><button class="btn secondary small" type="button" id="all-ok">Mark all OK</button></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Component ID</th><th>Component</th><th>Result</th><th>Remarks</th></tr></thead><tbody>' +
        outstanding.map(function (i, n) {
          return '<tr><td><b>' + esc(i.ComponentID) + '</b></td><td>' + esc(i.ComponentName) + (Number(i.QtyOut) > 1 ? ' x' + esc(i.QtyOut) : '') + '</td><td><select data-res="' + n + '">' +
            ['Not returned', 'OK', 'Damaged', 'Missing'].map(function (o) { return '<option>' + o + '</option>'; }).join('') + '</select></td>' +
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
        API.call('closeIssue', { IssueNo: f.dataset.issue, explanation: formData(f).explanation }).then(function (res) { reload('Issue closed. Ticket is now ' + res.status.toLowerCase()); }).catch(function (err) { toast(err.message); });
      });
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
