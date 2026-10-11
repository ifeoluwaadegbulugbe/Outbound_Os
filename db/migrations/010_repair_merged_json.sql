-- ============================================================================
-- 010 — Repair objects that were merged with a double-encoded patch.
-- `col || patch` where patch was a JSON string (see 009) produced an array
-- [original, "patch-as-text", …] instead of a merged object; later saves
-- appended more elements. Rebuild the object by merging the elements in order
-- (later saves win). Only arrays whose first element is an object and that
-- contain at least one string holding a JSON object are touched.
-- ============================================================================

do $$
declare
  c record;
  r record;
  e jsonb;
  merged jsonb;
  fixed int := 0;
begin
  for c in select table_name, column_name from information_schema.columns
           where table_schema = 'outbound' and data_type = 'jsonb'
  loop
    for r in execute format(
      'select ctid, %1$I as v from outbound.%2$I where jsonb_typeof(%1$I) = ''array'' and jsonb_typeof(%1$I -> 0) = ''object'''
      ' and exists (select 1 from jsonb_array_elements(%1$I) x where jsonb_typeof(x) = ''string'' and (x #>> ''{}'') ~ ''^\s*\{'')',
      c.column_name, c.table_name)
    loop
      merged := '{}'::jsonb;
      for e in select value from jsonb_array_elements(r.v) loop
        if jsonb_typeof(e) = 'string' then
          begin
            e := (e #>> '{}')::jsonb;
          exception when invalid_text_representation then
            continue;
          end;
        end if;
        if jsonb_typeof(e) = 'object' then
          merged := merged || e;
        end if;
      end loop;
      execute format('update outbound.%2$I set %1$I = $1 where ctid = $2', c.column_name, c.table_name) using merged, r.ctid;
      fixed := fixed + 1;
    end loop;
  end loop;
  raise notice 'merged % json values', fixed;
end $$;
