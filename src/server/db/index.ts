import { getDriver } from "./client";
import type { Driver, Queryable } from "./driver";
import { sql, toQuery, type SqlFragment } from "./sql";
import { runMigrations } from "./migrate";

export { sql, raw, join, and, or, json, textArray, uuidArray, values, empty } from "./sql";
export type { SqlFragment } from "./sql";

/** Typed query helpers bound to one connection/transaction. */
export interface Q {
  many<T = Record<string, unknown>>(f: SqlFragment): Promise<T[]>;
  one<T = Record<string, unknown>>(f: SqlFragment): Promise<T>;
  maybe<T = Record<string, unknown>>(f: SqlFragment): Promise<T | null>;
  exec(f: SqlFragment): Promise<void>;
  /** First column of first row. */
  value<T = unknown>(f: SqlFragment): Promise<T>;
}

export function bind(q: Queryable): Q {
  const run = <T>(f: SqlFragment) => {
    const { text, values } = toQuery(f);
    return q.query<T>(text, values);
  };
  return {
    many: run,
    async one<T>(f: SqlFragment) {
      const rows = await run<T>(f);
      if (rows.length === 0) throw new NotFoundError();
      return rows[0];
    },
    async maybe<T>(f: SqlFragment) {
      const rows = await run<T>(f);
      return rows[0] ?? null;
    },
    async exec(f: SqlFragment) {
      await run(f);
    },
    async value<T>(f: SqlFragment) {
      const rows = await run<Record<string, unknown>>(f);
      const row = rows[0];
      return (row ? Object.values(row)[0] : null) as T;
    },
  };
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

const g = globalThis as unknown as { __obMigrated?: Promise<void> };

/** Driver with migrations applied (auto-migrate in dev / when AUTO_MIGRATE=true). */
export async function db(): Promise<Driver> {
  const d = await getDriver();
  const auto = process.env.AUTO_MIGRATE ? process.env.AUTO_MIGRATE === "true" : d.kind === "pglite";
  if (auto) {
    g.__obMigrated ??= runMigrations(d).then(() => undefined).catch((e) => {
      g.__obMigrated = undefined;
      throw e;
    });
    await g.__obMigrated;
  }
  return d;
}

/**
 * Role used for row-level security. Each workspace transaction switches to
 * this non-privileged role so Postgres itself enforces tenant isolation, not
 * only application code. Set DB_RLS_ROLE="" to disable (not recommended).
 */
function rlsRole(): string | null {
  const r = process.env.DB_RLS_ROLE ?? "ob_app";
  if (!r) return null;
  if (!/^[a-z_][a-z0-9_]*$/.test(r)) throw new Error("Invalid DB_RLS_ROLE");
  return r;
}

export interface WorkspaceCtx {
  workspaceId: string;
  userId?: string | null;
}

/** Run fn in a transaction scoped to one workspace (RLS enforced). */
export async function withWorkspace<T>(ctx: WorkspaceCtx, fn: (q: Q) => Promise<T>, driver?: Driver): Promise<T> {
  const d = driver ?? (await db());
  const role = rlsRole();
  return d.transaction(async (tx) => {
    const q = bind(tx);
    await q.exec(
      sql`select set_config('app.workspace_id', ${ctx.workspaceId}, true),
                 set_config('app.user_id', ${ctx.userId ?? ""}, true),
                 set_config('app.system', 'off', true)`,
    );
    if (role) await tx.query(`set local role ${role}`);
    return fn(q);
  });
}

/**
 * System context: auth, migrations, the job worker's bookkeeping and
 * cross-workspace maintenance. Bypasses the workspace RLS policy via the
 * app.system flag, which only server code can set.
 */
export async function withSystem<T>(fn: (q: Q) => Promise<T>, driver?: Driver): Promise<T> {
  const d = driver ?? (await db());
  return d.transaction(async (tx) => {
    const q = bind(tx);
    await q.exec(sql`select set_config('app.system', 'on', true), set_config('app.workspace_id', '', true)`);
    return fn(q);
  });
}
