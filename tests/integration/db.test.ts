import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "@/server/db/driver";
import { withWorkspace, withSystem, sql, textArray, json, and } from "@/server/db";
import { testDb, createWorkspace } from "../helpers";

let d: Driver;
let wsA: string;
let wsB: string;

beforeAll(async () => {
  d = await testDb();
  wsA = await createWorkspace(d, "A");
  wsB = await createWorkspace(d, "B");
});
afterAll(async () => d?.close());

describe("database layer", () => {
  it("applies migrations and builds parameterized SQL", async () => {
    const tables = await d.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'outbound'",
    );
    expect(tables[0].n).toBeGreaterThan(30);

    const out = await withWorkspace({ workspaceId: wsA }, (q) =>
      q.one<{ arr: string[]; obj: { a: number }; ok: boolean }>(
        sql`select ${textArray(["a", 'b"c', "d,e"])} as arr, ${json({ a: 1 })} as obj, ${and([sql`1 = ${1}`, sql`'x' = ${"x"}`])} as ok`,
      ),
      d,
    );
    expect(out.arr).toEqual(["a", 'b"c', "d,e"]);
    expect(out.obj).toEqual({ a: 1 });
    expect(out.ok).toBe(true);
  });

  it("enforces workspace isolation with row-level security", async () => {
    await withWorkspace({ workspaceId: wsA }, (q) =>
      q.exec(sql`insert into prospects (workspace_id, business_name, normalized_name, source) values (${wsA}, 'Ada Glow Studio', 'ada glow studio', 'test')`),
      d,
    );
    await withWorkspace({ workspaceId: wsB }, (q) =>
      q.exec(sql`insert into prospects (workspace_id, business_name, normalized_name, source) values (${wsB}, 'Nails by Teni', 'nails by teni', 'test')`),
      d,
    );

    const seenByA = await withWorkspace({ workspaceId: wsA }, (q) => q.many<{ business_name: string }>(sql`select business_name from prospects`), d);
    expect(seenByA.map((r) => r.business_name)).toEqual(["Ada Glow Studio"]);

    // Writing into another workspace is rejected by the WITH CHECK policy.
    await expect(
      withWorkspace({ workspaceId: wsA }, (q) =>
        q.exec(sql`insert into prospects (workspace_id, business_name, normalized_name, source) values (${wsB}, 'Sneaky', 'sneaky', 'test')`),
        d,
      ),
    ).rejects.toThrow(/row-level security/i);

    // Updates cannot reach other workspaces' rows.
    await withWorkspace({ workspaceId: wsA }, (q) => q.exec(sql`update prospects set city = 'Hacked'`), d);
    const b = await withSystem((q) => q.one<{ city: string | null }>(sql`select city from prospects where workspace_id = ${wsB}`), d);
    expect(b.city).toBeNull();

    // System context sees everything.
    const all = await withSystem((q) => q.value<number>(sql`select count(*)::int from prospects`), d);
    expect(all).toBe(2);
  });

  it("hides sessions from workspace context", async () => {
    const rows = await withWorkspace({ workspaceId: wsA }, (q) => q.many(sql`select * from sessions`), d);
    expect(rows).toEqual([]);
  });
});
