// Loads the backend into the same fake Apps Script services the browser demo uses.
const fs = require('fs');
const path = require('path');
const GasFake = require('../docs/assets/js/gas-fake.js');

function backendSource() {
  // RTG_BUNDLE=1 tests the single pasted file (dist/Code.gs) instead of backend/*.gs.
  if (process.env.RTG_BUNDLE) return fs.readFileSync(path.join(__dirname, '..', 'dist', 'Code.gs'), 'utf8');
  const dir = path.join(__dirname, '..', 'backend');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

// RTG_EDGE=1 runs the tests on the strict-mode module the Supabase server uses (no sample data inside it).
function edgeBackend(services) {
  const { makeBackend } = require('../supabase/functions/rtg/backend.mjs');
  const api = makeBackend.apply(null, GasFake.NAMES.map((n) => services[n]));
  const sample = GasFake.loadBackend(backendSource(), services);
  return Object.assign({}, sample, api, { services });
}

function makeContext() {
  const services = GasFake.makeServices();
  const api = process.env.RTG_EDGE ? edgeBackend(services) : GasFake.loadBackend(backendSource(), services);
  api.__sheets = services.__sheets;
  api.__mails = services.__mails;
  return api;
}

module.exports = { makeContext };
