-- ============================================================================
-- 009 — Repair JSON values stored as JSON strings.
-- Before the json() helper cast through text, postgres.js serialized jsonb
-- parameters a second time, so hosted deployments stored '"{\"a\":1}"' (a
-- string) instead of '{"a":1}' (an object), which broke jobs and pages reading
-- those fields. Converts every such value back; values that don't parse as an
-- object/array are left as they are. No-op where nothing is affected.
-- ============================================================================

do $$
declare
  c record;
  r record;
  fixed int := 0;
begin
  for c in select table_name, column_name from information_schema.columns
           where table_schema = 'outbound' and data_type = 'jsonb'
  loop
    for r in execute format(
      'select ctid, %1$I #>> ''{}'' as txt from outbound.%2$I where jsonb_typeof(%1$I) = ''string'' and (%1$I #>> ''{}'') ~ ''^\s*[\{\[]''',
      c.column_name, c.table_name)
    loop
      begin
        execute format('update outbound.%2$I set %1$I = $1::jsonb where ctid = $2', c.column_name, c.table_name) using r.txt, r.ctid;
        fixed := fixed + 1;
      exception when invalid_text_representation then
        null; -- not valid JSON: leave it
      end;
    end loop;
  end loop;
  raise notice 'repaired % json values', fixed;
end $$;
