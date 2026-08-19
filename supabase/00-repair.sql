-- ═══════════════════════════════════════════════════════════════
-- Chrona — repair script
--
-- ⚠️  SETTING UP A NEW PROJECT? SKIP THIS FILE. Run setup.sql instead.
--
-- This only matters for one specific situation: a project where an
-- early version of schema.sql was run. That version used
-- `create table if not exists` with plain names (activities, entries,
-- tasks, habits, checks). If the project already had tables with those
-- names, the CREATEs silently did nothing — but the policies and
-- triggers were still applied on top of those pre-existing tables,
-- which breaks writes to them with:
--
--   operator does not exist: timestamp with time zone > bigint
--
-- This script removes only what Chrona added. It does not drop your
-- tables and does not touch a single row of your data.
--
-- Safe to run on a project that never had those tables: every step is
-- guarded, so it does nothing rather than erroring. (`drop trigger if
-- exists ... on public.activities` guards the *trigger*, not the
-- *table* — a missing table would still raise 42P01, hence the
-- to_regclass checks below.)
-- ═══════════════════════════════════════════════════════════════

do $$
declare
  t text;
  legacy text[] := array['activities', 'entries', 'tasks', 'habits', 'checks'];
  touched int := 0;
begin
  foreach t in array legacy loop
    -- to_regclass returns null instead of raising when the table is absent.
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    touched := touched + 1;

    execute format('drop trigger if exists set_user_id on public.%I', t);
    execute format('drop policy if exists %L on public.%I', 'own ' || t, t);
    -- The very first version used a per-table policy name; later ones
    -- used a shared name. Drop both spellings.
    execute format('drop policy if exists %L on public.%I', 'own rows', t);
    execute format('drop index if exists public.%I', t || '_sync_idx');
    execute format('drop index if exists public.%I', t || '_day_idx');
  end loop;

  -- Index names that don't follow the per-table pattern above.
  execute 'drop index if exists public.checks_one_per_day';

  if touched = 0 then
    raise notice 'Nothing to repair — none of the legacy tables exist in this project. You can ignore this file.';
  else
    raise notice 'Repaired % legacy table(s).', touched;
  end if;
end $$;

-- ── remove the function ──────────────────────────────────────
-- Safe unconditionally: `if exists` covers a function that was never
-- created, and `cascade` clears any trigger still bound to it.
drop function if exists public.chrona_set_user_id() cascade;

-- Note: row level security was enabled on those tables by the old
-- script. It is left ON deliberately — turning it back off would
-- expose them, and it is very likely they should have had it all
-- along. If one of these tables belongs to another project of yours
-- and it stopped working, add a policy for it rather than disabling
-- RLS:
--
--   create policy "..." on public.<table> for all to authenticated
--     using (true) with check (true);
--
-- To check which of your tables have RLS on but no policy:
--
--   select c.relname            as table_name,
--          c.relrowsecurity     as rls_enabled,
--          count(p.polname)     as policy_count
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   left join pg_policy p on p.polrelid = c.oid
--   where n.nspname = 'public' and c.relkind = 'r'
--   group by 1,2
--   order by 1;
