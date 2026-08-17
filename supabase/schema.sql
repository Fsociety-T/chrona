-- ═══════════════════════════════════════════════════════════════
-- Chrona — Supabase schema
--
-- Run 00-repair.sql FIRST if you ran an earlier version of this file.
--
-- Then here: Dashboard → SQL Editor → New query → paste → Run.
-- ═══════════════════════════════════════════════════════════════

-- ── why the chrona_ prefix ────────────────────────────────────
--
-- This project already had tables called activities, tasks, entries,
-- habits and checks. `create table if not exists` on those names does
-- nothing and reports success, so the app would have been left talking
-- to somebody else's tables with incompatible column types.
--
-- Prefixed names make that impossible, and mean this script can never
-- interfere with anything else in your database.

-- ── design notes ──────────────────────────────────────────────
--
-- Primary key is (user_id, id). The id is the same string the app
-- generates locally, so a row created offline keeps its identity when
-- it finally reaches the server, and two users can never collide.
--
-- id is TEXT, not uuid: the client generates short sortable ids
-- offline, with no server round-trip.
--
-- updated_at is epoch milliseconds (BIGINT), not timestamptz. The
-- client compares it directly against Date.now() for last-write-wins,
-- and incremental pulls are just `updated_at=gt.<last sync>`.
--
-- Deletes are soft: `deleted = true` is a tombstone. A hard DELETE
-- would be invisible to other devices, which would happily resurrect
-- the row on their next push.


-- ═══════════════ ACTIVITIES ═══════════════

create table if not exists public.chrona_activities (
  id          text        not null,
  user_id     uuid        not null default auth.uid()
                          references auth.users(id) on delete cascade,
  name        text        not null default '',
  color       text        not null default '#6c8cff',
  icon        text        not null default '*',
  archived    boolean     not null default false,
  sort_order  integer     not null default 0,
  deleted     boolean     not null default false,
  updated_at  bigint      not null default 0,
  primary key (user_id, id)
);


-- ═══════════════ ENTRIES (time sessions) ═══════════════

create table if not exists public.chrona_entries (
  id           text       not null,
  user_id      uuid       not null default auth.uid()
                          references auth.users(id) on delete cascade,
  activity_id  text,
  task_id      text,
  habit_id     text,
  note         text       not null default '',
  start_at     bigint     not null,
  end_at       bigint     not null,
  day          text       not null,          -- 'YYYY-MM-DD', local to the device
  deleted      boolean    not null default false,
  updated_at   bigint     not null default 0,
  primary key (user_id, id)
);


-- ═══════════════ TASKS ═══════════════

create table if not exists public.chrona_tasks (
  id            text      not null,
  user_id       uuid      not null default auth.uid()
                          references auth.users(id) on delete cascade,
  title         text      not null default '',
  notes         text      not null default '',
  activity_id   text,
  done          integer   not null default 0,
  created_at    bigint    not null default 0,
  completed_at  bigint,
  due_day       text,
  deleted       boolean   not null default false,
  updated_at    bigint    not null default 0,
  primary key (user_id, id)
);


-- ═══════════════ HABITS ═══════════════

create table if not exists public.chrona_habits (
  id           text       not null,
  user_id      uuid       not null default auth.uid()
                          references auth.users(id) on delete cascade,
  name         text       not null default '',
  color        text       not null default '#6c8cff',
  icon         text       not null default 'o',
  type         text       not null default 'check',   -- 'check' | 'timed'
  target_min   integer    not null default 0,
  days         integer[]  not null default '{0,1,2,3,4,5,6}',
  activity_id  text,
  archived     boolean    not null default false,
  created_at   bigint     not null default 0,
  deleted      boolean    not null default false,
  updated_at   bigint     not null default 0,
  primary key (user_id, id)
);


-- ═══════════════ CHECKS (habit completions) ═══════════════

create table if not exists public.chrona_checks (
  id         text         not null,
  user_id    uuid         not null default auth.uid()
                          references auth.users(id) on delete cascade,
  habit_id   text         not null,
  day        text         not null,
  done_at    bigint       not null default 0,
  deleted    boolean      not null default false,
  updated_at bigint       not null default 0,
  primary key (user_id, id)
);

-- One live check per habit per day. Without this, two devices ticking
-- the same habit offline would each create a row and the streak would
-- count that day twice.
create unique index if not exists chrona_checks_one_per_day
  on public.chrona_checks (user_id, habit_id, day)
  where deleted = false;


-- ═══════════════ SAFETY CHECK ═══════════════
-- If any table above already existed with different column types, the
-- CREATE was a silent no-op and the app would misbehave in confusing
-- ways. Fail loudly here instead.

do $$
declare
  bad text;
begin
  -- Every name here must be qualified: `want` and information_schema.columns
  -- both have table_name and column_name.
  -- information_schema columns are sql_identifier, not text, so every
  -- comparison below is cast explicitly.
  select string_agg(
           format('%s.%s is %s, expected %s',
                  want.table_name, want.column_name, c.data_type::text, want.expected),
           E'\n')
  into bad
  from (
    values
      ('chrona_activities','id','text'),
      ('chrona_activities','updated_at','bigint'),
      ('chrona_entries','id','text'),
      ('chrona_entries','updated_at','bigint'),
      ('chrona_entries','start_at','bigint'),
      ('chrona_tasks','id','text'),
      ('chrona_tasks','updated_at','bigint'),
      ('chrona_habits','id','text'),
      ('chrona_habits','updated_at','bigint'),
      ('chrona_checks','id','text'),
      ('chrona_checks','updated_at','bigint')
  ) as want(table_name, column_name, expected)
  join information_schema.columns c
    on c.table_schema::text = 'public'
   and c.table_name::text   = want.table_name
   and c.column_name::text  = want.column_name
  where c.data_type::text <> want.expected;

  if bad is not null then
    raise exception E'Chrona tables exist with unexpected column types:\n%\n\nDrop the chrona_* tables and re-run this script.', bad;
  end if;
end $$;


-- ═══════════════ INDEXES ═══════════════
-- Every pull is "give me my rows changed since X", so this is the
-- index that matters on all five tables.

create index if not exists chrona_activities_sync_idx on public.chrona_activities (user_id, updated_at);
create index if not exists chrona_entries_sync_idx    on public.chrona_entries    (user_id, updated_at);
create index if not exists chrona_tasks_sync_idx      on public.chrona_tasks      (user_id, updated_at);
create index if not exists chrona_habits_sync_idx     on public.chrona_habits     (user_id, updated_at);
create index if not exists chrona_checks_sync_idx     on public.chrona_checks     (user_id, updated_at);

-- Reading a day or a date range is the app's other hot path.
create index if not exists chrona_entries_day_idx on public.chrona_entries (user_id, day);
create index if not exists chrona_checks_day_idx  on public.chrona_checks  (user_id, day);


-- ═══════════════ ROW LEVEL SECURITY ═══════════════
-- Without this, the anon key would let anyone read everyone's rows.
-- With it, the key is safe to ship inside the app.

alter table public.chrona_activities enable row level security;
alter table public.chrona_entries    enable row level security;
alter table public.chrona_tasks      enable row level security;
alter table public.chrona_habits     enable row level security;
alter table public.chrona_checks     enable row level security;

-- `using` guards what you can read/update/delete.
-- `with check` guards what you can insert/update *into* — without it a
-- user could write rows tagged with someone else's user_id.

drop policy if exists "own rows" on public.chrona_activities;
create policy "own rows" on public.chrona_activities
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.chrona_entries;
create policy "own rows" on public.chrona_entries
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.chrona_tasks;
create policy "own rows" on public.chrona_tasks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.chrona_habits;
create policy "own rows" on public.chrona_habits
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.chrona_checks;
create policy "own rows" on public.chrona_checks
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ═══════════════ SERVER-SIDE GUARDS ═══════════════

-- Force user_id to the caller, whatever the client sends. Belt and
-- braces alongside the RLS check above.
create or replace function public.chrona_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  -- A client with a wrong clock could otherwise stamp a row far in the
  -- future and permanently win every conflict. Clamp to "now" plus a
  -- small allowance for clock skew.
  if new.updated_at is null
     or new.updated_at > (extract(epoch from now()) * 1000)::bigint + 60000 then
    new.updated_at := (extract(epoch from now()) * 1000)::bigint;
  end if;
  return new;
end;
$$;

drop trigger if exists chrona_stamp on public.chrona_activities;
create trigger chrona_stamp before insert or update on public.chrona_activities
  for each row execute function public.chrona_stamp();

drop trigger if exists chrona_stamp on public.chrona_entries;
create trigger chrona_stamp before insert or update on public.chrona_entries
  for each row execute function public.chrona_stamp();

drop trigger if exists chrona_stamp on public.chrona_tasks;
create trigger chrona_stamp before insert or update on public.chrona_tasks
  for each row execute function public.chrona_stamp();

drop trigger if exists chrona_stamp on public.chrona_habits;
create trigger chrona_stamp before insert or update on public.chrona_habits
  for each row execute function public.chrona_stamp();

drop trigger if exists chrona_stamp on public.chrona_checks;
create trigger chrona_stamp before insert or update on public.chrona_checks
  for each row execute function public.chrona_stamp();


-- ═══════════════ DONE ═══════════════
-- If this ran without error, the backend is ready.
-- Next: Settings → Cloud sync → Connect Supabase in the app.
