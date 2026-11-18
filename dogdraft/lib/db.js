/**
 * Database access. In production this talks to the Neon Postgres database
 * that Vercel connects to the project (it injects DATABASE_URL). Tests swap
 * in an in-memory Postgres with setTestDatabase().
 *
 * Every query is parameterized ($1, $2, ...). Never build SQL by string
 * concatenation with user input.
 */
import { neon } from '@neondatabase/serverless';

let adapter = null; // (text, params) => Promise<rows[]>
let schemaReady = null; // Promise, shared per warm function instance

/** Used only by tests. */
export function setTestDatabase(queryFn) {
  adapter = queryFn;
  schemaReady = null;
}

function getAdapter() {
  if (adapter) return adapter;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    const err = new Error('Database is not connected yet. Add a Neon database to this Vercel project.');
    err.status = 503;
    throw err;
  }
  const sql = neon(url);
  adapter = (text, params = []) => sql.query(text, params);
  return adapter;
}

/** Run one parameterized statement and return its rows. */
export async function query(text, params = []) {
  await ensureSchema();
  return getAdapter()(text, params);
}

/**
 * Create tables on first use so setup needs no manual SQL step.
 * Idempotent: safe to run on every cold start.
 */
export function ensureSchema() {
  if (!schemaReady) {
    const run = getAdapter();
    schemaReady = (async () => {
      await run(`CREATE TABLE IF NOT EXISTS players (
        id          SERIAL PRIMARY KEY,
        first_name  TEXT NOT NULL,
        last_name   TEXT NOT NULL,
        name_key    TEXT NOT NULL UNIQUE,
        pin_hash    TEXT NOT NULL,
        picks       JSONB NOT NULL,
        bis_pick    TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await run(`CREATE TABLE IF NOT EXISTS results (
        slot        TEXT PRIMARY KEY,
        breed_id    TEXT NOT NULL,
        revealed    BOOLEAN NOT NULL DEFAULT false,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      // One entry per device: the browser's device id (see lib/device.js).
      // ADD COLUMN IF NOT EXISTS keeps this safe on databases created earlier.
      await run('ALTER TABLE players ADD COLUMN IF NOT EXISTS device_id TEXT');
      // Ranked Best in Show calls (JSON array). Older rows only have bis_pick,
      // which is still written (first call) and read as a fallback.
      await run('ALTER TABLE players ADD COLUMN IF NOT EXISTS bis_picks JSONB');
      await run('CREATE INDEX IF NOT EXISTS players_device_id_idx ON players (device_id)');
      await run(`CREATE TABLE IF NOT EXISTS rate_limits (
        key           TEXT PRIMARY KEY,
        count         INTEGER NOT NULL,
        window_start  TIMESTAMPTZ NOT NULL
      )`);
    })().catch((e) => {
      schemaReady = null; // allow a retry on the next request
      throw e;
    });
  }
  return schemaReady;
}
