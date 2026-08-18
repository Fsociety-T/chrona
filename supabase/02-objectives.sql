-- ═══════════════════════════════════════════════════════════════
-- Chrona — objectives
--
-- Run this after schema.sql, in the same place:
--   Dashboard → SQL Editor → New query → paste → Run
--
-- Adds one table. Nothing else is touched, so it is safe to run on a
-- project that already has data in it.
-- ═══════════════════════════════════════════════════════════════

-- An objective is a target over a date window: "Deep work 40h this
-- month", "20 study sessions before the exam".
--
-- Note there is no progress column. Progress is recomputed from entries
-- on the client every time it is shown, so correcting or deleting a
-- session updates the objective immediately. A stored counter would
-- drift out of step with the timeline the first time you fixed a
-- mistake, and then quietly stay wrong.
--
-- achieved_at IS stored, because *when* you hit a target is a fact worth
-- keeping rather than something to recompute.

create table if not exists public.chrona_objectives (
  id           text       not null,
  user_id      uuid       not null default auth.uid()
                          references auth.users(id) on delete cascade,
  title        text       not null default '',
  activity_id  text,                                  -- null = any activity
  metric       text       not null default 'hours',   -- 'hours' | 'sessions'
  target       double precision not null default 0,
  from_day     text       not null,                   -- 'YYYY-MM-DD'
  to_day       text       not null,
  icon         text       not null default 'o',
  achieved_at  bigint,                                -- null until hit
  archived     boolean    not null default false,
  created_at   bigint     not null default 0,
  deleted      boolean    not null default false,
  updated_at   bigint     not null default 0,
  primary key (user_id, id),

  -- A target of zero would be achieved the moment it was created, and an
  -- inverted window can never be satisfied. Reject both at the source.
  constraint chrona_objectives_target_positive check (target > 0),
  constraint chrona_objectives_window_valid    check (to_day >= from_day),
  constraint chrona_objectives_metric_known    check (metric in ('hours', 'sessions'))
);

-- The pull query is always "my rows changed since X".
create index if not exists chrona_objectives_sync_idx
  on public.chrona_objectives (user_id, updated_at);

-- Listing open objectives is the other hot path.
create index if not exists chrona_objectives_window_idx
  on public.chrona_objectives (user_id, to_day);


-- ═══════════════ ROW LEVEL SECURITY ═══════════════

alter table public.chrona_objectives enable row level security;

drop policy if exists "own rows" on public.chrona_objectives;
create policy "own rows" on public.chrona_objectives
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ═══════════════ SERVER-SIDE GUARD ═══════════════
-- Same trigger the other tables use: force user_id to the caller and
-- clamp a client clock that is running ahead.

drop trigger if exists chrona_stamp on public.chrona_objectives;
create trigger chrona_stamp before insert or update on public.chrona_objectives
  for each row execute function public.chrona_stamp();


-- ═══════════════ DONE ═══════════════
-- If this ran without error, the Goals tab will sync.
