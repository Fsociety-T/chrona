-- ═══════════════════════════════════════════════════════════════
-- Chrona — activity kind
--
-- Run after schema.sql and 02-objectives.sql:
--   Dashboard → SQL Editor → New query → paste → Run
--
-- Adds one column. Safe to run on a project with data in it.
-- ═══════════════════════════════════════════════════════════════

-- `kind` is what makes "where does my time actually go" answerable.
-- The classification is the user's own judgement, not the app's:
--   productive — time you'd want back if you lost it
--   neutral    — necessary or restorative; neither win nor waste
--   draining   — time you'd rather have spent otherwise
--
-- Existing rows default to 'neutral', which is the honest starting
-- point: the app has no basis for guessing, and a wrong guess would
-- quietly skew every productivity figure derived from it.

alter table public.chrona_activities
  add column if not exists kind text not null default 'neutral';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chrona_activities_kind_known'
  ) then
    alter table public.chrona_activities
      add constraint chrona_activities_kind_known
      check (kind in ('productive', 'neutral', 'draining'));
  end if;
end $$;

-- ═══════════════ DONE ═══════════════
-- Set each activity's kind in the app: Today → Quick start → Manage.
