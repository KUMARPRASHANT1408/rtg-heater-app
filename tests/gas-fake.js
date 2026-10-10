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

function makeContext() {
  const services = GasFake.makeServices();
  const api = GasFake.loadBackend(backendSource(), services);
  api.__sheets = services.__sheets;
  api.__mails = services.__mails;
  return api;
}

module.exports = { makeContext };
