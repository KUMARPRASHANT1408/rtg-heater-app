// @ts-nocheck
// RTG Heater Management API on Supabase (Edge Function "rtg").
// Deployed by .github/workflows/supabase-deploy.yml; see SUPABASE.md. The app logic is in backend.mjs (generated
// from backend/*.gs, the same code as the Google Sheets version) and core.mjs (keeps the tabs in Postgres).
import postgres from 'npm:postgres@3.4.5';
import { makeServer, pgFiles } from './core.mjs';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), { max: 4, prepare: false, idle_timeout: 20 });
const db = {
  run: (text) => sql.unsafe(text),
  tx: (fn) => sql.begin((tx) => fn((text, params) => tx.unsafe(text, params || [])))
};

// Checklist photos go to Supabase Storage (1 GB free) in a private bucket. If Storage can't be reached
// they are kept in the database instead, so an upload never fails because of it.
const SUPA_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = 'rtg-files';
const inDb = pgFiles();

function storageHeaders(extra) {
  return Object.assign({ Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY }, extra || {});
}
function bytesOf(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64Of(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function upload(f) {
  return fetch(SUPA_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(f.id), {
    method: 'POST', headers: storageHeaders({ 'Content-Type': f.type, 'x-upsert': 'true' }), body: bytesOf(f.b64)
  });
}

const files = !SUPA_URL || !SERVICE_KEY ? inDb : {
  put: async (q, f) => {
    try {
      let res = await upload(f);
      if (!res.ok && /bucket/i.test(await res.clone().text())) {
        await fetch(SUPA_URL + '/storage/v1/bucket', { method: 'POST', headers: storageHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
        res = await upload(f);
      }
      if (res.ok) return;
      console.error('storage upload failed', res.status, await res.text());
    } catch (err) {
      console.error('storage upload failed', err);
    }
    await inDb.put(q, f);
  },
  get: async (q, id) => {
    const local = await inDb.get(q, id);
    if (local) return local;
    const res = await fetch(SUPA_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(id), { headers: storageHeaders() });
    if (!res.ok) return null;
    return { id, type: res.headers.get('content-type') || 'application/octet-stream', b64: b64Of(await res.arrayBuffer()) };
  },
  bytes: async (q) => {
    // A failed query would spoil the whole transaction, so check the table exists first.
    const has = await q("select to_regclass('storage.objects') is not null as ok");
    if (!has[0].ok) return 0;
    const r = await q("select coalesce(sum((metadata->>'size')::bigint), 0)::float8 as b from storage.objects where bucket_id = $1", [BUCKET]);
    return Number(r[0].b);
  }
};

const server = makeServer({ db, files, log: (m) => console.log(m) });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  let body;
  if (request.method === 'GET') {
    body = { ok: true, app: 'RTG Heater API (Supabase)' };
  } else {
    let req;
    try {
      req = JSON.parse(await request.text());
    } catch (e) {
      req = null;
    }
    body = req ? await server.handle(req) : { ok: false, error: 'Bad request.' };
  }
  return new Response(JSON.stringify(body), { headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
});
