-- ═══════════════════════════════════════════════════════════════
-- Chrona — repair script
--
-- RUN THIS FIRST, before schema.sql.
--
-- The first version of schema.sql used `create table if not exists`
-- with plain names (activities, entries, tasks, habits, checks).
-- This project already had tables with those names, so the CREATEs
-- silently did nothing — but the policies and triggers were still
-- applied on top of those pre-existing tables, which breaks writes
-- to them with:
--
--   operator does not exist: timestamp with time zone > bigint
--
-- This script removes only what Chrona added. It does not drop your
-- tables and does not touch a single row of your data.
-- ═══════════════════════════════════════════════════════════════

-- ── remove the triggers Chrona attached ──────────────────────
drop trigger if exists set_user_id on public.activities;
drop trigger if exists set_user_id on public.entries;
drop trigger if exists set_user_id on public.tasks;
drop trigger if exists set_user_id on public.habits;
drop trigger if exists set_user_id on public.checks;

-- ── remove the policies Chrona added ─────────────────────────
drop policy if exists "own activities" on public.activities;
drop policy if exists "own entries"    on public.entries;
drop policy if exists "own tasks"      on public.tasks;
drop policy if exists "own habits"     on public.habits;
drop policy if exists "own checks"     on public.checks;

-- ── remove the indexes Chrona added ──────────────────────────
drop index if exists public.activities_sync_idx;
drop index if exists public.entries_sync_idx;
drop index if exists public.tasks_sync_idx;
drop index if exists public.habits_sync_idx;
drop index if exists public.checks_sync_idx;
drop index if exists public.entries_day_idx;
drop index if exists public.checks_day_idx;
drop index if exists public.checks_one_per_day;

-- ── remove the function ──────────────────────────────────────
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
