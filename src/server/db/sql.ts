/**
 * Minimal, safe SQL builder.
 *
 *   sql`select * from prospects where id = ${id}`
 *
 * Interpolated values always become bind parameters ($1, $2, ...), never
 * string-concatenated SQL. Nested `sql` fragments are inlined, so dynamic
 * WHERE clauses can be composed safely with `join`, `and`, `or`.
 *
 * Arrays and JSON need explicit helpers (`textArray`, `json`) because the two
 * drivers (PGlite and postgres.js) infer parameter types differently; the
 * helpers send text plus an explicit cast so behaviour is identical.
 */

const FRAGMENT = Symbol("sql.fragment");

export interface SqlFragment {
  readonly [FRAGMENT]: true;
  readonly chunks: readonly string[];
  readonly values: readonly unknown[];
}

function isFragment(v: unknown): v is SqlFragment {
  return typeof v === "object" && v !== null && (v as SqlFragment)[FRAGMENT] === true;
}

function make(chunks: string[], values: unknown[]): SqlFragment {
  return { [FRAGMENT]: true, chunks, values };
}

export function sql(strings: TemplateStringsArray, ...vals: unknown[]): SqlFragment {
  const chunks: string[] = [strings[0]];
  const values: unknown[] = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (isFragment(v)) {
      // Merge: last chunk + first nested chunk, nested middle, nested last + next string.
      chunks[chunks.length - 1] += v.chunks[0];
      for (let j = 0; j < v.values.length; j++) {
        values.push(v.values[j]);
        chunks.push(v.chunks[j + 1]);
      }
      chunks[chunks.length - 1] += strings[i + 1];
    } else {
      values.push(v);
      chunks.push(strings[i + 1]);
    }
  }
  return make(chunks, values);
}

/** Raw SQL text. ONLY for identifiers/keywords from a hard-coded allowlist. */
export function raw(text: string): SqlFragment {
  return make([text], []);
}

export const empty: SqlFragment = make([""], []);

export function join(parts: SqlFragment[], separator = ", "): SqlFragment {
  if (parts.length === 0) return empty;
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out = sql`${out}${raw(separator)}${parts[i]}`;
  }
  return out;
}

export function and(parts: (SqlFragment | null | undefined | false | "")[]): SqlFragment {
  const p = parts.filter(Boolean) as SqlFragment[];
  if (p.length === 0) return sql`true`;
  return sql`(${join(p, " and ")})`;
}

export function or(parts: (SqlFragment | null | undefined | false | "")[]): SqlFragment {
  const p = parts.filter(Boolean) as SqlFragment[];
  if (p.length === 0) return sql`false`;
  return sql`(${join(p, " or ")})`;
}

function pgArrayLiteral(items: readonly (string | number | null)[]): string {
  return (
    "{" +
    items
      .map((s) => (s === null ? "NULL" : `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`))
      .join(",") +
    "}"
  );
}

export function textArray(items: readonly string[] | null | undefined): SqlFragment {
  if (items == null) return sql`null::text[]`;
  return sql`${pgArrayLiteral(items)}::text[]`;
}

export function uuidArray(items: readonly string[]): SqlFragment {
  return sql`${pgArrayLiteral(items)}::uuid[]`;
}

export function json(value: unknown): SqlFragment {
  if (value === undefined) return sql`null::jsonb`;
  return sql`${JSON.stringify(value)}::jsonb`;
}

/** Bulk VALUES list: values([[a,b],[c,d]]) -> ($1,$2),($3,$4) */
export function values(rows: unknown[][]): SqlFragment {
  return join(rows.map((r) => sql`(${join(r.map((v) => (isFragment(v) ? v : sql`${v}`)))})`));
}

export function toQuery(f: SqlFragment): { text: string; values: unknown[] } {
  let text = f.chunks[0];
  for (let i = 0; i < f.values.length; i++) {
    text += `$${i + 1}` + f.chunks[i + 1];
  }
  const vals = f.values.map((v) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v));
  return { text, values: vals };
}
