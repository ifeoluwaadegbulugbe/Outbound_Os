import path from "node:path";
import fs from "node:fs";
import { pgliteDir } from "./paths";

/**
 * Database driver abstraction. Two implementations, one interface:
 *
 *  - postgres.js   when DATABASE_URL is set (production: any Postgres 15+,
 *                  e.g. a dedicated Supabase/Neon/RDS database)
 *  - PGlite        embedded Postgres (WASM) for local dev and tests, so the
 *                  app runs with zero installs. Data lives in .data/pglite.
 *
 * Everything above this layer speaks plain SQL text + bind values.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
}

export interface Driver extends Queryable {
  readonly kind: "pglite" | "postgres";
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement script without parameters (migrations). */
  execScript(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface DriverOptions {
  databaseUrl?: string;
  /** PGlite data dir. "memory://" for an in-memory DB (tests). */
  pgliteDir?: string;
}

export async function createDriver(opts: DriverOptions = {}): Promise<Driver> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) return createPostgresDriver(url);
  if (process.env.NODE_ENV === "production" && !process.env.ALLOW_PGLITE_IN_PRODUCTION) {
    throw new Error(
      "DATABASE_URL is not set. Embedded PGlite is for development only — set DATABASE_URL to a Postgres database " +
        "(or ALLOW_PGLITE_IN_PRODUCTION=1 for a single-instance demo).",
    );
  }
  return createPgliteDriver(opts.pgliteDir ?? pgliteDir());
}

const SEARCH_PATH = "outbound, public, extensions";

async function createPostgresDriver(url: string): Promise<Driver> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // Supabase/PgBouncer transaction pooling does not support prepared statements.
    prepare: process.env.DB_PREPARE === "false" ? false : !url.includes(":6543"),
    connection: { search_path: SEARCH_PATH, application_name: "orbit-outbound" },
    onnotice: () => {},
    types: {
      // Return bigint as JS number (counts/ids we produce stay well below 2^53).
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
  const wrap = (q: { unsafe: (t: string, v?: unknown[]) => Promise<unknown> }): Queryable => ({
    async query<T>(text: string, values: unknown[] = []) {
      return timed(text, async () => (await q.unsafe(text, values as never[])) as unknown as T[]);
    },
  });
  const base = wrap(sql as never);
  return {
    kind: "postgres",
    query: base.query,
    async transaction<T>(fn: (q: Queryable) => Promise<T>) {
      return (await sql.begin((tx) => fn(wrap(tx as never)))) as T;
    },
    async execScript(text: string) {
      await sql.unsafe(text);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * PGlite is single-process: two processes opening the same directory will
 * corrupt it. A pid lock file makes the second one fail loudly instead.
 */
function acquireLock(dir: string) {
  const lock = path.join(dir, "..", "pglite.lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    let alive = false;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(
        `The embedded database is in use by another process (pid ${pid}) — usually the dev server. ` +
          "Stop it first, or use the in-app equivalent (Settings → Demo data).",
      );
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
}

/** Slow-query log: set SLOW_QUERY_MS (e.g. 3000) to print any statement slower than that. */
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? 0);
async function timed<T>(text: string, fn: () => Promise<T>): Promise<T> {
  if (!SLOW_MS) return fn();
  const t = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t;
    if (ms >= SLOW_MS) console.warn(`[db] slow query ${ms} ms: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

async function createPgliteDriver(dir: string): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  if (!dir.startsWith("memory://")) {
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(dir);
  }
  const db = await PGlite.create(dir.startsWith("memory://") ? undefined : dir, {
    extensions: { pg_trgm },
  });
  await db.exec(`create schema if not exists outbound; set search_path to ${SEARCH_PATH};`);

  // int8 -> number, numeric -> number (matches the postgres.js config above).
  const parsers = {
    20: (v: string) => Number(v),
    1700: (v: string) => Number(v),
  };
  const wrap = (q: { query: (t: string, v?: unknown[], o?: object) => Promise<{ rows: unknown[] }> }): Queryable => ({
    async query<T>(text: string, values: unknown[] = []) {
      return timed(text, async () => (await q.query(text, values, { parsers })).rows as T[]);
    },
  });
  const base = wrap(db as never);
  return {
    kind: "pglite",
    query: base.query,
    async transaction<T>(fn: (q: Queryable) => Promise<T>) {
      return db.transaction((tx) => fn(wrap(tx as never)));
    },
    async execScript(text: string) {
      await db.exec(text);
    },
    async close() {
      await db.close();
    },
  };
}
