// The Supabase server: runs the SAME backend code as the Google Sheets version, but each tab lives in Postgres.
// Per request: load the tabs from Postgres into the in-memory Sheet the backend already knows (gas-fake),
// run the action, then write back only the rows that changed, all in one transaction.
// Works with any `db` that offers run(sql) and tx(async (q) => ...) where q(sql, params) returns rows,
// so the tests use PGlite and the Edge Function uses postgres.js.
import { GasFake, makeBackend } from './backend.mjs';

// Tabs the app only ever adds to. They are never loaded (they grow forever); new rows are just inserted.
const APPEND_ONLY = ['AuditLog', 'MailOutbox'];
const LOG_LIMIT = 300; // newest rows shown on the admin page (same as backend/Admin.gs)
const TABLES = 6; // tables in the DDL below
const WRITE_LOCK = 7151; // pg_advisory_xact_lock key: one writer at a time, like Apps Script's LockService
const IST_MS = 330 * 60000;
const DB_LIMIT = 500 * 1024 * 1024; // Supabase free plan
const FILE_LIMIT = 1024 * 1024 * 1024;

export const DDL = `
create schema if not exists rtg;
create table if not exists rtg.tabs (tab text primary key, pos int not null, header jsonb not null);
create table if not exists rtg.rows (id bigserial primary key, tab text not null, data jsonb not null);
create index if not exists rows_tab on rtg.rows (tab, id);
create table if not exists rtg.cache (key text primary key, value text not null, expires timestamptz not null);
create table if not exists rtg.mail (id bigserial primary key, created timestamptz not null default now(), mail jsonb not null, sent timestamptz);
create table if not exists rtg.files (id text primary key, type text not null, b64 text not null);
create table if not exists rtg.meta (key text primary key, value text not null);
alter table rtg.tabs enable row level security;
alter table rtg.rows enable row level security;
alter table rtg.cache enable row level security;
alter table rtg.mail enable row level security;
alter table rtg.files enable row level security;
alter table rtg.meta enable row level security;
`;

function pad(n) { return (n < 10 ? '0' : '') + n; }

// Apps Script formats dates in the script's time zone (India); the server clock is UTC.
function formatDateIST(d, tz, pattern) {
  var x = new Date(new Date(d).getTime() + IST_MS);
  return pattern.replace('yyyy', x.getUTCFullYear()).replace('MM', pad(x.getUTCMonth() + 1)).replace('dd', pad(x.getUTCDate()))
    .replace('HH', pad(x.getUTCHours())).replace('mm', pad(x.getUTCMinutes())).replace('ss', pad(x.getUTCSeconds()));
}

// Cell values travel as JSON; a Date is {"$d": iso} (the same as the browser demo).
function toJson(v) {
  if (v instanceof Date) return { $d: v.toISOString() };
  return v === undefined || v === null ? '' : v;
}
function fromJson(v) { return v && typeof v === 'object' && v.$d ? new Date(v.$d) : v; }
function rowJson(row) {
  var out = [];
  for (var i = 0; i < row.length; i++) out.push(toJson(row[i]));
  while (out.length && out[out.length - 1] === '') out.pop();
  return JSON.stringify(out);
}

function sha256Hex(s) {
  return GasFake.sha256(GasFake.utf8(String(s))).map(function (b) { return pad16((b + 256) % 256); }).join('');
}
function pad16(n) { return (n < 16 ? '0' : '') + n.toString(16); }

function base64ToBytes(b64) {
  var bin = atob(b64), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Checklist files kept in Postgres. The Edge Function puts them in Supabase Storage instead when it can (see index.ts).
export function pgFiles() {
  return {
    put: function (q, f) {
      return q('insert into rtg.files (id, type, b64) values ($1, $2, $3) on conflict (id) do update set type = excluded.type, b64 = excluded.b64',
        [f.id, f.type, f.b64]);
    },
    get: async function (q, id) {
      var r = await q('select type, b64 from rtg.files where id = $1', [id]);
      return r.length ? { id: id, type: r[0].type, b64: r[0].b64 } : null;
    },
    bytes: async function () { return 0; } // counted inside the database size
  };
}

export function makeServer(opts) {
  var db = opts.db;
  var files = opts.files || pgFiles();
  var log = opts.log || function () {};
  var ddlDone = false, schemaChecked = false;
  var READ_ONLY = makeBackend.apply(null, GasFake.NAMES.map(function () { return {}; })).READ_ONLY;

  // Supabase starts many copies of the function. The tables are made once; after that a new copy must not run the
  // DDL again, because ALTER TABLE locks each table and deadlocks with requests already running.
  async function init() {
    if (ddlDone) return;
    var have = await tx(function (q) { return q("select count(*)::int as n from pg_tables where schemaname = 'rtg'"); });
    if (have[0].n < TABLES) await db.run(DDL);
    ddlDone = true;
  }

  // A transaction that Postgres cancelled to break a deadlock, or a serialization clash, changed nothing: try again.
  async function tx(fn) {
    for (var attempt = 1; ; attempt++) {
      try {
        return await db.tx(fn);
      } catch (err) {
        var code = err && (err.code || (err.cause && err.cause.code));
        if (attempt >= 4 || (code !== '40P01' && code !== '40001')) throw err;
        log('retrying after ' + code);
        await new Promise(function (r) { setTimeout(r, 20 * attempt + Math.random() * 40); });
      }
    }
  }

  // ---------- load the tabs into an in-memory Sheet ----------
  async function load(q, preFiles) {
    var tabs = await q('select tab, pos, header from rtg.tabs order by pos');
    var rows = await q('select id::text as rid, tab, data from rtg.rows where tab not in (select jsonb_array_elements_text($1::text::jsonb)) order by tab, id',
      [JSON.stringify(APPEND_ONLY)]);
    var cacheRows = await q('select key, value from rtg.cache where expires > now()');
    var state = { sheets: {}, cache: {}, files: {} };
    var ids = new WeakMap(), snap = {}, before = {};
    tabs.forEach(function (t) {
      state.sheets[t.tab] = [t.header.map(fromJson)];
      snap[t.tab] = new Map();
      before[t.tab] = { pos: t.pos, header: JSON.stringify(t.header) };
    });
    rows.forEach(function (r) {
      var sheet = state.sheets[r.tab];
      if (!sheet) return;
      var row = r.data.map(fromJson);
      sheet.push(row);
      ids.set(row, r.rid);
      snap[r.tab].set(r.rid, JSON.stringify(r.data));
    });
    cacheRows.forEach(function (c) { state.cache[c.key] = c.value; });
    var ctx = { state: state, ids: ids, snap: snap, before: before, cacheBefore: Object.assign({}, state.cache),
                ttl: {}, mails: [], newFiles: [], needFile: null, truncate: [], ready: tabs.length > 0 };
    ctx.services = services(ctx, preFiles || {});
    ctx.api = makeBackend.apply(null, GasFake.NAMES.map(function (n) { return ctx.services[n]; }));
    return ctx;
  }

  function services(ctx, preFiles) {
    var s = GasFake.makeServices({ state: ctx.state });
    s.Utilities.formatDate = formatDateIST;
    s.CacheService = { getScriptCache: function () {
      var c = ctx.state.cache;
      return {
        get: function (k) { return Object.prototype.hasOwnProperty.call(c, k) ? c[k] : null; },
        put: function (k, v, ttl) { c[k] = String(v); ctx.ttl[k] = ttl || 600; },
        remove: function (k) { delete c[k]; delete ctx.ttl[k]; }
      };
    } };
    s.MailApp = { sendEmail: function (m) { ctx.mails.push(m); } };
    s.Logger = { log: function (m) { log(String(m)); } };
    function file(id) {
      var f = preFiles[id] || ctx.state.files[id];
      if (!f) { ctx.needFile = id; throw new Error('Checklist file is loading, try again.'); }
      return { getId: function () { return id; }, getName: function () { return f.name || id; },
               getBlob: function () { return s.Utilities.newBlob({ b64: f.b64 }, f.type, f.name || id); } };
    }
    var folder = { getId: function () { return 'supabase'; }, createFile: function (blob) {
      var id = 'sb-' + s.Utilities.getUuid();
      var b64 = blob.data && blob.data.b64 !== undefined ? blob.data.b64 : GasFake.base64(blob.data);
      ctx.state.files[id] = { name: blob.name, type: blob.type, b64: b64 };
      ctx.newFiles.push({ id: id, type: blob.type, b64: b64 });
      return file(id);
    } };
    s.DriveApp = { createFolder: function () { return folder; }, getFolderById: function () { return folder; }, getFileById: file };
    return s;
  }

  // ---------- write back what changed ----------
  async function persist(q, ctx, sheetsToo) {
    if (sheetsToo) {
      var sheets = ctx.state.sheets, names = Object.keys(sheets);
      for (var t = 0; t < ctx.truncate.length; t++) await q('delete from rtg.rows where tab = $1', [ctx.truncate[t]]);
      for (var i = 0; i < names.length; i++) {
        var tab = names[i], data = sheets[tab], header = rowJson(data[0] || []);
        var was = ctx.before[tab];
        if (!was) await q('insert into rtg.tabs (tab, pos, header) values ($1, $2, $3::text::jsonb)', [tab, i, header]);
        else if (was.header !== header) await q('update rtg.tabs set header = $2::text::jsonb where tab = $1', [tab, header]);
        var inserts = [], updates = [], seen = new Set(), snap = ctx.snap[tab] || new Map();
        for (var r = 1; r < data.length; r++) {
          var row = data[r];
          if (!row) continue;
          var json = rowJson(row), id = ctx.ids.get(row);
          if (id === undefined) inserts.push(json);
          else {
            seen.add(id);
            if (snap.get(id) !== json) updates.push('[' + JSON.stringify(id) + ',' + json + ']');
          }
        }
        var deletes = [];
        snap.forEach(function (v, id) { if (!seen.has(id)) deletes.push(id); });
        if (deletes.length) await q('delete from rtg.rows where id in (select jsonb_array_elements_text($1::text::jsonb)::bigint)', [JSON.stringify(deletes)]);
        if (updates.length) {
          await q('update rtg.rows r set data = u.x->1 from jsonb_array_elements($1::text::jsonb) u(x) where r.id = (u.x->>0)::bigint',
            ['[' + updates.join(',') + ']']);
        }
        if (inserts.length) {
          await q('insert into rtg.rows (tab, data) select $1, x from jsonb_array_elements($2::text::jsonb) with ordinality t(x, n) order by n',
            [tab, '[' + inserts.join(',') + ']']);
        }
      }
      var gone = Object.keys(ctx.before).filter(function (n) { return !sheets[n]; });
      for (var g = 0; g < gone.length; g++) {
        await q('delete from rtg.rows where tab = $1', [gone[g]]);
        await q('delete from rtg.tabs where tab = $1', [gone[g]]);
      }
      for (var f = 0; f < ctx.newFiles.length; f++) await files.put(q, ctx.newFiles[f]);
      if (ctx.mails.length) {
        await q('insert into rtg.mail (mail) select x from jsonb_array_elements($1::text::jsonb) with ordinality t(x, n) order by n',
          [JSON.stringify(ctx.mails.map(mailJson))]);
      }
    }
    // Sessions and failed-login counters.
    var c = ctx.state.cache, puts = [], dels = [];
    Object.keys(c).forEach(function (k) {
      if (ctx.ttl[k] !== undefined) puts.push([k, c[k], ctx.ttl[k]]);
    });
    Object.keys(ctx.cacheBefore).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(c, k)) dels.push(k); });
    if (dels.length) await q('delete from rtg.cache where key in (select jsonb_array_elements_text($1::text::jsonb))', [JSON.stringify(dels)]);
    if (puts.length) {
      await q("insert into rtg.cache (key, value, expires) select x->>0, x->>1, now() + ((x->>2)::int * interval '1 second') " +
        'from jsonb_array_elements($1::text::jsonb) x on conflict (key) do update set value = excluded.value, expires = excluded.expires',
        [JSON.stringify(puts)]);
    }
  }

  function mailJson(m) {
    var out = { to: m.to, cc: m.cc || '', subject: m.subject, body: m.body || '', htmlBody: m.htmlBody || '' };
    out.attachments = (m.attachments || []).map(function (b) {
      var data = b.getBytes ? b.getBytes() : b.data;
      return { name: b.getName ? b.getName() : b.name, type: b.getContentType ? b.getContentType() : b.type,
               text: typeof data === 'string' ? data : undefined, b64: data && data.b64 !== undefined ? data.b64 : undefined };
    });
    return out;
  }

  // Runs fn(api, ctx) against freshly loaded tabs and saves the result. write = take the lock and save the tabs.
  async function run(write, fn, after) {
    await init();
    return tx(async function (q) {
      var lock = write || !schemaChecked;
      if (lock) await q('select pg_advisory_xact_lock(' + WRITE_LOCK + ')');
      var preFiles = {};
      for (var attempt = 0; attempt < 2; attempt++) {
        var ctx = await load(q, preFiles);
        if (!ctx.ready) return { ok: false, error: 'The app is not connected yet. Run connectSupabase() in Apps Script (see SUPABASE.md).' };
        if (!schemaChecked) {
          ctx.api.setup(); // adds any tabs, columns and settings a newer version of the app needs
          schemaChecked = true;
        }
        var result = fn(ctx.api, ctx);
        if (ctx.needFile && attempt === 0) {
          var f = await files.get(q, ctx.needFile);
          if (!f) return { ok: false, error: 'This checklist file is missing.' };
          preFiles[ctx.needFile] = f;
          continue;
        }
        if (after) result = await after(q, ctx, result);
        await persist(q, ctx, lock);
        return result;
      }
    });
  }

  // ---------- the HTTP entry: one JSON request in, one JSON reply out ----------
  async function handle(req) {
    req = req || {};
    try {
      var action = String(req.action || '');
      if (action.indexOf('relay') === 0) return await relay(action, req);
      if (action === 'storageInfo') return await storageInfo(req);
      if (action === 'adminLog') return await adminLog(req);
      var write = READ_ONLY.indexOf(action) < 0; // login and logout count as writes (sessions)
      return await run(write, function (api, ctx) {
        if (action === 'clearTestData') ctx.truncate = APPEND_ONLY.slice();
        var res = api.handle(req);
        if (action === 'clearTestData' && !res.ok) ctx.truncate = [];
        return res;
      });
    } catch (err) {
      log('error: ' + (err && err.stack || err));
      return { ok: false, error: 'Server error: ' + (err && err.message || err) };
    }
  }

  async function storageInfo(req) {
    return run(false, function (api) {
      try { api.requireUser(req.token, ['Admin']); } catch (err) { return { ok: false, error: err.message, auth: !!err.auth }; }
      return { ok: true };
    }, async function (q, ctx, res) {
      if (!res.ok) return res;
      var size = await q('select pg_database_size(current_database())::float8 as b');
      var fileBytes = await files.bytes(q);
      return { ok: true, data: { dbBytes: Number(size[0].b), dbLimit: DB_LIMIT, fileBytes: fileBytes, fileLimit: FILE_LIMIT } };
    });
  }

  // The activity and mail logs are never loaded into memory (they only grow), so read their newest rows straight from Postgres.
  // Same answer as the backend's apiLog().
  async function adminLog(req) {
    var d = req.data || {};
    var tab = APPEND_ONLY.indexOf(d.log) >= 0 ? d.log : 'AuditLog';
    return run(false, function (api) {
      try { api.requireUser(req.token, ['Admin']); } catch (err) { return { ok: false, error: err.message, auth: !!err.auth }; }
      return { ok: true };
    }, async function (q, ctx, res) {
      if (!res.ok) return res;
      var head = await q('select header from rtg.tabs where tab = $1', [tab]);
      var rows = await q('select data from rtg.rows where tab = $1 order by id desc limit ' + (LOG_LIMIT + 1), [tab]);
      var cols = head.length ? head[0].header : [];
      var out = rows.slice(0, LOG_LIMIT).map(function (r) {
        var o = {};
        cols.forEach(function (c, i) {
          var v = r.data[i] === undefined ? '' : r.data[i];
          o[c] = v && typeof v === 'object' && v.$d ? formatDateIST(v.$d, '', 'yyyy-MM-dd HH:mm') : v;
        });
        return o;
      });
      return { ok: true, data: { log: tab, columns: cols, rows: out, more: rows.length > LOG_LIMIT } };
    });
  }

  // ---------- the Apps Script relay (mail, daily jobs, backup copy, first data copy) ----------
  async function relay(action, req) {
    await init();
    var d = req.data || {};
    if (action === 'relayRegister') {
      return tx(async function (q) {
        await q('select pg_advisory_xact_lock(' + WRITE_LOCK + ')');
        var have = await q("select value from rtg.meta where key = 'relay_key'");
        var hash = sha256Hex(req.key || '');
        if (String(req.key || '').length < 32) return { ok: false, error: 'Relay key too short.' };
        if (!have.length) await q("insert into rtg.meta (key, value) values ('relay_key', $1)", [hash]);
        else if (have[0].value !== hash) return { ok: false, error: 'A different Apps Script is already connected to this Supabase project.' };
        return { ok: true, data: { connected: true } };
      });
    }
    var key = await tx(function (q) { return q("select value from rtg.meta where key = 'relay_key'"); });
    if (!key.length || key[0].value !== sha256Hex(req.key || '')) return { ok: false, error: 'Relay key not accepted.' };

    if (action === 'relayImport') return importTabs(d);
    if (action === 'relayFile') {
      return tx(async function (q) {
        await files.put(q, { id: String(d.id), type: String(d.type || 'application/octet-stream'), b64: String(d.b64 || '') });
        return { ok: true, data: { id: d.id } };
      });
    }
    if (action === 'relayMail') {
      return tx(async function (q) {
        var rows = await q('select id::text as rid, mail from rtg.mail where sent is null order by id limit 40');
        return { ok: true, data: rows.map(function (r) { return { id: r.rid, mail: r.mail }; }) };
      });
    }
    if (action === 'relayMailDone') {
      return tx(async function (q) {
        await q('update rtg.mail set sent = now() where id in (select jsonb_array_elements_text($1::text::jsonb)::bigint)', [JSON.stringify(d.ids || [])]);
        await q("delete from rtg.mail where sent < now() - interval '30 days'");
        await q('delete from rtg.cache where expires < now()');
        return { ok: true, data: { done: (d.ids || []).length } };
      });
    }
    if (action === 'relayDaily') {
      return run(true, function (api) { return { ok: true, data: { overdueMails: api.dailyJobs() } }; });
    }
    if (action === 'relayResetAdmin') {
      return run(true, function (api) { return { ok: true, data: { message: api.resetAdminPassword() } }; });
    }
    if (action === 'relayExport') {
      return tx(async function (q) {
        var tabs = await q('select tab, header from rtg.tabs order by pos');
        var rows = await q('select tab, data from rtg.rows order by tab, id');
        var out = {};
        tabs.forEach(function (t) { out[t.tab] = [t.header]; });
        rows.forEach(function (r) { if (out[r.tab]) out[r.tab].push(r.data); });
        return { ok: true, data: { order: tabs.map(function (t) { return t.tab; }), tabs: out } };
      });
    }
    return { ok: false, error: 'Unknown relay action: ' + action };
  }

  // First copy of the Google Sheet into Postgres (and again with replace: true, only before going live).
  async function importTabs(d) {
    var order = d.order || Object.keys(d.tabs || {});
    if (!order.length) return { ok: false, error: 'No tabs sent.' };
    var done = await tx(async function (q) {
      await q('select pg_advisory_xact_lock(' + WRITE_LOCK + ')');
      var have = await q('select count(*)::int as n from rtg.tabs');
      if (have[0].n && !d.replace) return { ok: false, error: 'Data was already copied. Use copyDataAgain() to replace it (only before going live).' };
      await q('delete from rtg.rows');
      await q('delete from rtg.tabs');
      await q('delete from rtg.cache');
      for (var i = 0; i < order.length; i++) {
        var values = (d.tabs[order[i]] || []).map(function (r) { return JSON.parse(rowJson(r)); });
        if (!values.length) continue;
        await q('insert into rtg.tabs (tab, pos, header) values ($1, $2, $3::text::jsonb)', [order[i], i, JSON.stringify(values[0])]);
        var body = values.slice(1).filter(function (r) { return r.length; });
        if (body.length) {
          await q('insert into rtg.rows (tab, data) select $1, x from jsonb_array_elements($2::text::jsonb) with ordinality t(x, n) order by n',
            [order[i], JSON.stringify(body)]);
        }
      }
      return { ok: true };
    });
    if (!done.ok) return done;
    schemaChecked = false;
    // setup() adds anything missing and, if there were no users at all, makes "admin" with a temporary password.
    return run(true, function (api) { return { ok: true, data: { message: api.setup(), tabs: order.length } }; });
  }

  return { handle: handle, init: init };
}

export { base64ToBytes };
