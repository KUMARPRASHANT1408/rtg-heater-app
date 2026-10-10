// In-memory stand-ins for the Apps Script services the backend uses.
// Used two ways: by the Node tests, and by demo mode in the browser, where the REAL backend
// code (assets/js/backend-bundle.js) runs against these fakes with data kept in localStorage.
(function (root) {
  // ---- small synchronous SHA-256 (Apps Script's computeDigest is synchronous, WebCrypto is not) ----
  var K = [];
  (function () {
    var n = 2, found = 0;
    function frac(x) { return ((x - Math.floor(x)) * 4294967296) | 0; }
    while (found < 64) {
      var prime = true;
      for (var f = 2; f * f <= n; f++) if (n % f === 0) { prime = false; break; }
      if (prime) K[found++] = frac(Math.pow(n, 1 / 3));
      n++;
    }
  })();
  function utf8(str) {
    var out = [], s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }
  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    var bits = l * 8;
    for (var s = 7; s >= 0; s--) m.push(s >= 4 ? 0 : (bits >>> (s * 8)) & 0xff);
    var w = new Array(64);
    for (var i = 0; i < m.length; i += 64) {
      for (var t = 0; t < 16; t++) w[t] = (m[i + 4 * t] << 24) | (m[i + 4 * t + 1] << 16) | (m[i + 4 * t + 2] << 8) | m[i + 4 * t + 3];
      for (t = 16; t < 64; t++) {
        var x = w[t - 15], y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    H.forEach(function (v) { out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); });
    return out.map(function (b) { return b > 127 ? b - 256 : b; }); // Apps Script returns signed bytes
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(bytes) {
    var u = bytes.map(function (b) { return (b + 256) % 256; }), out = '';
    for (var i = 0; i < u.length; i += 3) {
      var n = (u[i] << 16) | ((u[i + 1] || 0) << 8) | (u[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < u.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function formatDate(d, tz, pattern) {
    return pattern.replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
      .replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes()));
  }

  // ---- sheets ----
  function makeSheet(name, data) {
    var sheet = {
      name: name,
      data: data,
      getName: function () { return name; },
      setName: function () { return sheet; },
      getLastRow: function () { return data.length; },
      getLastColumn: function () { return data.reduce(function (m, r) { return Math.max(m, r.length); }, 0); },
      getDataRange: function () {
        var w = sheet.getLastColumn();
        return { getValues: function () { return data.map(function (r) { var o = []; for (var i = 0; i < w; i++) o.push(r[i] === undefined ? '' : r[i]); return o; }); } };
      },
      getRange: function (row, col, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        var range = {
          getValues: function () {
            var out = [];
            for (var i = 0; i < nr; i++) { var r = []; for (var j = 0; j < nc; j++) { var v = (data[row - 1 + i] || [])[col - 1 + j]; r.push(v === undefined ? '' : v); } out.push(r); }
            return out;
          },
          setValues: function (vals) {
            if (vals.length !== nr || vals.some(function (v) { return v.length !== nc; })) throw new Error('setValues size mismatch');
            vals.forEach(function (v, i) { var r = (data[row - 1 + i] = data[row - 1 + i] || []); v.forEach(function (x, j) { r[col - 1 + j] = x; }); });
            return range;
          },
          setValue: function (v) { var r = (data[row - 1] = data[row - 1] || []); r[col - 1] = v; return range; },
          setFontWeight: function () { return range; }, setBackground: function () { return range; }, setFontColor: function () { return range; }
        };
        return range;
      },
      setFrozenRows: function () {}
    };
    return sheet;
  }

  // Dates survive JSON as {"$d": iso}.
  function revive(k, v) { return v && typeof v === 'object' && v.$d ? new Date(v.$d) : v; }
  function replace(k, v) { return this[k] instanceof Date ? { $d: this[k].toISOString() } : v; }

  function makeServices(opts) {
    opts = opts || {};
    var raw = opts.load ? opts.load() : null;
    var state = raw ? JSON.parse(raw, revive) : { sheets: {}, cache: {} };
    var sheets = {};
    Object.keys(state.sheets).forEach(function (n) { sheets[n] = makeSheet(n, state.sheets[n]); });
    var mails = [];
    var ss = {
      getId: function () { return 'demo'; },
      getSheetByName: function (n) { return sheets[n] || null; },
      insertSheet: function (n) { state.sheets[n] = []; return (sheets[n] = makeSheet(n, state.sheets[n])); },
      getSheets: function () { return Object.keys(sheets).map(function (k) { return sheets[k]; }); },
      deleteSheet: function (s) { delete sheets[s.name]; delete state.sheets[s.name]; }
    };
    var services = {
      SpreadsheetApp: { getActive: function () { return ss; }, flush: function () {} },
      CacheService: { getScriptCache: function () {
        return {
          get: function (k) { return Object.prototype.hasOwnProperty.call(state.cache, k) ? state.cache[k] : null; },
          put: function (k, v) { state.cache[k] = String(v); },
          remove: function (k) { delete state.cache[k]; }
        };
      } },
      LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: function (alg, s) { return sha256(utf8(String(s))); },
        base64Encode: base64,
        getUuid: uuid,
        formatDate: formatDate
      },
      Session: { getScriptTimeZone: function () { return 'Asia/Kolkata'; } },
      MailApp: { sendEmail: function (m) { mails.push(m); } },
      Logger: { log: function (m) { services.__logs.push(m); } },
      ContentService: { createTextOutput: function (s) { return { s: s, setMimeType: function () { return this; } }; }, MimeType: { JSON: 'json' } },
      ScriptApp: { getProjectTriggers: function () { return []; } },
      __logs: [],
      __mails: mails,
      __sheets: sheets,
      __save: function () { if (opts.save) opts.save(JSON.stringify(state, replace)); }
    };
    return services;
  }

  var NAMES = ['SpreadsheetApp', 'CacheService', 'LockService', 'Utilities', 'Session', 'MailApp', 'Logger', 'ContentService', 'ScriptApp'];
  var EXPORTS = ['handle', 'setup', 'loadSampleData', 'readTable', 'updateWhere', 'appendRow', 'hashPassword', 'newSalt', 'nextNumber', 'queueMail',
                 'sendOverdueMails', 'today', 'resetAdminPassword', 'SCHEMA'];

  // Runs the backend source with the fakes injected; returns its functions.
  function loadBackend(source, services) {
    var fn = new Function(NAMES.join(','), source + '\nreturn {' + EXPORTS.map(function (e) { return e + ': typeof ' + e + " !== 'undefined' ? " + e + ' : undefined'; }).join(',') + '};');
    var api = fn.apply(null, NAMES.map(function (n) { return services[n]; }));
    api.services = services;
    return api;
  }

  var GasFake = { makeServices: makeServices, loadBackend: loadBackend, sha256: sha256, base64: base64 };
  if (typeof module !== 'undefined') module.exports = GasFake;
  else root.GasFake = GasFake;
})(this);
