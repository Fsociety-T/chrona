/* ═══════════════════════════════════════════════════════════════
   store.js — application state, timer engine, all data operations
   Every mutation goes through here, then emits 'change' so views
   re-render. The running timer is persisted to the DB, so closing
   the app mid-session does not lose the elapsed time.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var PALETTE = [
    '#6c8cff', '#22c9a8', '#f5a524', '#f2557a', '#a97bff',
    '#3fb6e8', '#7dc94b', '#ff8a5c', '#e05fc4', '#5fd0c0'
  ];

  /* `kind` is what makes "where does my time actually go" answerable:
     productive = time you'd want back if you lost it,
     neutral    = necessary or restorative, neither win nor waste,
     draining   = time you'd rather have spent otherwise.
     It's your call per activity — the app only does the arithmetic. */
  var KINDS = ['productive', 'neutral', 'draining'];

  var DEFAULT_ACTIVITIES = [
    { name: 'Deep work', color: '#6c8cff', icon: '🎯', kind: 'productive' },
    { name: 'Study',     color: '#22c9a8', icon: '📚', kind: 'productive' },
    { name: 'Exercise',  color: '#f5a524', icon: '🏃', kind: 'productive' },
    { name: 'Rest',      color: '#a97bff', icon: '🌙', kind: 'neutral' },
    { name: 'Scrolling', color: '#f2557a', icon: '📱', kind: 'draining' }
  ];

  /* ── in-memory state ──────────────────────────────────────── */
  var state = {
    activities: [],
    entries: [],     // recent window only (loaded per range)
    tasks: [],
    habits: [],
    checks: [],
    objectives: [],
    running: null,   // { activityId, taskId, habitId, note, start }
    ready: false
  };

  var listeners = [];
  function on(fn) { listeners.push(fn); return function () { off(fn); }; }
  function off(fn) { listeners = listeners.filter(function (l) { return l !== fn; }); }
  function emit() { listeners.forEach(function (fn) { fn(state); }); }

  /* ── ids & dates ──────────────────────────────────────────── */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ── sync bookkeeping ─────────────────────────────────────── */

  /* Stamp a record as locally changed. Every write to a synced store
     goes through here so nothing can silently skip the next push. */
  function touch(rec) {
    rec.updated_at = Date.now();
    rec.dirty = 1;
    if (rec.deleted == null) rec.deleted = 0;
    return rec;
  }

  /* Tombstone rather than remove: a hard delete is invisible to other
     devices, which would happily push the row back on their next sync. */
  function tombstone(storeName, rec) {
    var dead = Object.assign({}, rec, { deleted: 1 });
    touch(dead);
    return DB.put(storeName, dead);
  }

  function isLive(rec) { return !rec.deleted; }

  function dayKey(d) {
    var x = d ? new Date(d) : new Date();
    var m = String(x.getMonth() + 1).padStart(2, '0');
    var day = String(x.getDate()).padStart(2, '0');
    return x.getFullYear() + '-' + m + '-' + day;
  }

  function addDays(dayStr, n) {
    var p = dayStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return dayKey(d);
  }

  function todayKey() { return dayKey(); }

  /* ── bootstrap ────────────────────────────────────────────── */
  function init() {
    return DB.open()
      .then(reload)
      .then(function () {
        if (!state.activities.length) return seedActivities();
      })
      .then(function () {
        state.ready = true;
        emit();
        return state;
      });
  }

  /* Re-read everything from the database into memory. Called at boot and
     again after a sync pull, so merged server rows show up immediately.
     Tombstones are filtered out here — the rest of the app never sees them. */
  function reload() {
    return Promise.all([
      DB.all('activities'), DB.all('tasks'), DB.all('habits'),
      DB.all('checks'), DB.get('meta', 'running'), DB.all('objectives')
    ]).then(function (res) {
      state.activities = res[0].filter(isLive).sort(function (a, b) { return a.order - b.order; });
      state.tasks      = res[1].filter(isLive);
      state.habits     = res[2].filter(isLive);
      state.checks     = res[3].filter(isLive);
      state.running    = res[4] ? res[4].value : null;
      state.objectives = (res[5] || []).filter(isLive);
      return loadEntries(addDays(todayKey(), -120), todayKey());
    });
  }

  function seedActivities() {
    var recs = DEFAULT_ACTIVITIES.map(function (a, i) {
      return touch({
        id: uid(), name: a.name, color: a.color, icon: a.icon,
        kind: a.kind, archived: false, order: i
      });
    });
    state.activities = recs;
    return DB.putAll('activities', recs);
  }

  /* How far back the in-memory window currently reaches. */
  var loadedFrom = null;

  /* Load entries for a day range into memory.
     The lower bound is widened by a day because a session that started
     the evening before still overlaps `fromDay`. */
  function loadEntries(fromDay, toDay) {
    loadedFrom = fromDay;
    return DB.range('entries', 'day', addDays(fromDay, -1), toDay).then(function (rows) {
      state.entries = rows.filter(isLive).sort(function (a, b) { return a.start - b.start; });
      return state.entries;
    });
  }

  /* Widen the window when the user pages back past what's loaded.
     Without this, browsing to an older day would show an empty day that
     actually has entries sitting in the database. */
  function ensureLoaded(day) {
    if (loadedFrom && day >= loadedFrom) return Promise.resolve(false);
    var from = addDays(day, -30);   // a margin, so paging back isn't one fetch per day
    return loadEntries(from, todayKey()).then(function () { emit(); return true; });
  }

  /* ═══════════════ TIMER ENGINE ═══════════════ */

  /* A session is a run of one or more worked *segments*, split by pauses.
     Each segment is written as its own entry the moment it ends — on
     pause as well as on stop — so the timeline and the day's totals are
     never waiting on you to finish.

     That also keeps the invariant everything else depends on: for every
     entry, duration === end - start. A single row spanning a lunch break
     would break the midnight slicing, the overlap check and the day
     totals all at once, and would misreport when you actually worked. */

  /* Write one worked segment. Returns the entry, or null when it was too
     short to be anything but a mis-tap. */
  function writeSegment(r, startTs, endTs) {
    if (!startTs || !endTs || endTs - startTs < 5000) return Promise.resolve(null);

    var entry = touch({
      id: uid(),
      activityId: r.activityId,
      taskId: r.taskId,
      habitId: r.habitId,
      note: r.note || '',
      start: startTs,
      end: endTs,
      day: dayKey(startTs)
    });
    state.entries.push(entry);
    state.entries.sort(function (a, b) { return a.start - b.start; });

    return DB.put('entries', entry).then(function () {
      if (entry.habitId) return maybeAutoCheck(entry.habitId, entry.day);
    }).then(refreshAchievements).then(function () { return entry; });
  }

  /* Start tracking. Any already-running timer is stopped and saved first. */
  function start(opts) {
    opts = opts || {};
    var switching = !!state.running;

    var begin = function () {
      state.running = {
        activityId: opts.activityId || null,
        taskId: opts.taskId || null,
        habitId: opts.habitId || null,
        note: opts.note || '',
        // Start of the current open segment. Null while paused.
        start: Date.now(),
        // Start of the whole session, which pausing does not move.
        sessionStart: Date.now(),
        // Time from segments already written, so the clock on screen keeps
        // counting the session rather than restarting at each resume.
        accumulated: 0,
        paused: 0,
        // Advanced only while the app is on screen, so it records when you
        // were last actually here — which is what makes "stop at last
        // activity" a real answer rather than a guess.
        lastSeen: Date.now(),
        // Set once the runaway prompt has been shown for this session, so
        // reopening the app doesn't ask again.
        warned: 0
      };
      return DB.put('meta', { key: 'running', value: state.running }).then(function () {
        // One cue for a switch, rather than a stop chime chased by a start one.
        if (global.Sound) Sound.play(switching ? 'switch' : 'start');
        emit();
        return state.running;
      });
    };

    // `silent` here so the stop half of a switch doesn't play its own cue.
    return switching ? stop(true).then(begin) : begin();
  }

  /* Stop the session, writing whatever segment is still open. */
  function stop(silent) {
    if (!state.running) return Promise.resolve(null);
    if (!silent && global.Sound) Sound.play('stop');

    var r = state.running;
    var openStart = r.start;      // null when the session is paused
    state.running = null;

    return DB.put('meta', { key: 'running', value: null })
      .then(function () { return writeSegment(r, openStart, Date.now()); })
      .then(function (entry) { emit(); return entry; });
  }

  /* Pause: close the current segment, keep the selection. */
  function pause() {
    var r = state.running;
    if (!r || r.paused || !r.start) return Promise.resolve(null);

    if (global.Sound) Sound.play('pause');
    var openStart = r.start;

    return writeSegment(r, openStart, Date.now()).then(function (entry) {
      // Only count time that actually got logged, so the clock on screen
      // can never claim more than the timeline shows.
      r.accumulated = (r.accumulated || 0) + (entry ? entry.end - entry.start : 0);
      r.start = null;
      r.paused = 1;
      return saveRunning();
    }).then(function () { emit(); return state.running; });
  }

  function resume() {
    var r = state.running;
    if (!r || !r.paused) return Promise.resolve(null);

    if (global.Sound) Sound.play('resume');
    r.start = Date.now();
    r.lastSeen = Date.now();
    r.paused = 0;
    return saveRunning().then(function () { emit(); return r; });
  }

  function isPaused() { return !!(state.running && state.running.paused); }

  /* Total active time in the session — completed segments plus the open
     one. A pause freezes it rather than resetting it. */
  function elapsed() {
    var r = state.running;
    if (!r) return 0;
    return (r.accumulated || 0) + (r.start ? Date.now() - r.start : 0);
  }

  /* When the whole session began, which pausing doesn't move.
     Falls back to `start` for records written before pause existed. */
  function sessionStart() {
    var r = state.running;
    return r ? (r.sessionStart || r.start) : 0;
  }

  /* Persist the running record without disturbing anything else. */
  function saveRunning() {
    if (!state.running) return Promise.resolve();
    return DB.put('meta', { key: 'running', value: state.running });
  }

  /* Called from the app's tick while the page is visible. Throttled: the
     tick fires every second and this only needs a coarse "still here". */
  var lastBeat = 0;
  function heartbeat() {
    if (!state.running) return Promise.resolve();
    var now = Date.now();
    state.running.lastSeen = now;
    if (now - lastBeat < 60000) return Promise.resolve();
    lastBeat = now;
    return saveRunning();
  }

  /* Mark the runaway prompt as answered for this session. */
  function markWarned() {
    if (!state.running) return Promise.resolve();
    state.running.warned = 1;
    return saveRunning();
  }

  /* Stop the running timer at a specific past moment — used by the
     runaway-timer prompt's "stop at last activity". */
  function stopAt(endTs) {
    var r = state.running;
    if (!r) return Promise.resolve(null);

    var openStart = r.start;
    var end = openStart ? Math.max(openStart, Math.min(endTs, Date.now())) : null;

    state.running = null;
    return DB.put('meta', { key: 'running', value: null })
      .then(function () { return writeSegment(r, openStart, end); })
      .then(function (entry) { emit(); return entry; });
  }

  /* Throw away the running timer without logging anything. */
  function discardRunning() {
    if (!state.running) return Promise.resolve();
    state.running = null;
    return DB.put('meta', { key: 'running', value: null }).then(function () { emit(); });
  }

  /* What is the running timer actually called? */
  function runningLabel() {
    var r = state.running;
    if (!r) return null;
    if (r.taskId) {
      var t = taskById(r.taskId);
      if (t) return t.title;
    }
    if (r.habitId) {
      var h = habitById(r.habitId);
      if (h) return h.name;
    }
    var a = activityById(r.activityId);
    return a ? a.name : 'Tracking';
  }

  /* ═══════════════ ENTRIES ═══════════════ */

  function addManualEntry(data) {
    var entry = touch({
      id: uid(),
      activityId: data.activityId || null,
      taskId: data.taskId || null,
      habitId: data.habitId || null,
      note: data.note || '',
      start: data.start,
      end: data.end,
      day: dayKey(data.start)
    });
    state.entries.push(entry);
    state.entries.sort(function (a, b) { return a.start - b.start; });
    return DB.put('entries', entry).then(function () {
      if (entry.habitId) return maybeAutoCheck(entry.habitId, entry.day);
    }).then(refreshAchievements).then(function () { emit(); return entry; });
  }

  function entryById(id) {
    return state.entries.find(function (e) { return e.id === id; }) || null;
  }

  /* Correct an already-logged session. */
  function updateEntry(id, data) {
    var prev = entryById(id);
    if (!prev) return Promise.reject(new Error('That entry no longer exists.'));

    var rec = touch(Object.assign({}, prev, data));
    // An edit can move a session onto a different day, so `day` is always
    // re-derived rather than carried over from the previous version.
    rec.day = dayKey(rec.start);

    state.entries = state.entries
      .map(function (e) { return e.id === id ? rec : e; })
      .sort(function (a, b) { return a.start - b.start; });

    return DB.put('entries', rec).then(function () {
      // Changing a duration can push a timed habit over its daily target,
      // or was already over it and still is — either way, re-check.
      if (rec.habitId) return maybeAutoCheck(rec.habitId, rec.day);
    }).then(refreshAchievements).then(function () { emit(); return rec; });
  }

  function deleteEntry(id) {
    var rec = entryById(id);
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    if (!rec) return Promise.resolve();
    // Removing time can drop an objective back below its target, so the
    // achievement has to be re-evaluated rather than left standing.
    return tombstone('entries', rec)
      .then(refreshAchievements)
      .then(function () { emit(); });
  }

  /* Epoch ms bounds of a local day. */
  function dayBounds(day) {
    var p = day.split('-');
    var from = new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0).getTime();
    var to = new Date(+p[0], +p[1] - 1, +p[2] + 1, 0, 0, 0, 0).getTime();
    return [from, to];
  }

  /* How much of an entry actually falls inside `day`.

     A session from 23:30 to 07:00 belongs to two days. Matching on the
     stored `day` field alone would credit all 7.5h to the evening and
     leave the morning showing nothing, so every per-day number is
     computed from the overlap instead. */
  function sliceForDay(entry, day) {
    var b = dayBounds(day);
    return Math.max(0, Math.min(entry.end, b[1]) - Math.max(entry.start, b[0]));
  }

  /* Entries touching a day — not just those that started on it. */
  function entriesForDay(day) {
    var b = dayBounds(day);
    return state.entries.filter(function (e) { return e.start < b[1] && e.end > b[0]; });
  }

  function entriesInRange(fromDay, toDay) {
    var lo = dayBounds(fromDay)[0];
    var hi = dayBounds(toDay)[1];
    return state.entries.filter(function (e) { return e.start < hi && e.end > lo; });
  }

  function durationOf(e) { return Math.max(0, e.end - e.start); }

  /* Does an entry cross a midnight boundary? Used by the timeline to
     label a session that shows up on more than one day. */
  function spansDays(e) {
    return dayKey(e.start) !== dayKey(e.end - 1);
  }

  /* How much of the running timer falls inside `day`.

     Only the open segment counts here — segments closed by a pause were
     already written as entries, so counting them again would double them. */
  function runningSliceForDay(day) {
    var r = state.running;
    if (!r || !r.start) return 0;
    return sliceForDay({ start: r.start, end: Date.now() }, day);
  }

  /* Total ms tracked on a day, optionally including the live timer. */
  function totalForDay(day, includeRunning) {
    var sum = entriesForDay(day).reduce(function (n, e) { return n + sliceForDay(e, day); }, 0);
    if (includeRunning) sum += runningSliceForDay(day);
    return sum;
  }

  /* How much of an entry falls inside a day range, inclusive. */
  function sliceForRange(entry, fromDay, toDay) {
    var lo = dayBounds(fromDay)[0];
    var hi = dayBounds(toDay)[1];
    return Math.max(0, Math.min(entry.end, hi) - Math.max(entry.start, lo));
  }

  /* Group entries by activity → [{activity, ms}] sorted desc.

     Pass a day range to scope each entry to its overlap with it. Without
     that, an entry hanging over either edge is counted in full and the
     activity breakdown stops matching the totals above it. */
  function byActivity(entries, includeRunning, fromDay, toDay) {
    if (fromDay && !toDay) toDay = fromDay;

    var map = new Map();
    entries.forEach(function (e) {
      var k = e.activityId || '_none';
      var ms = fromDay ? sliceForRange(e, fromDay, toDay) : durationOf(e);
      map.set(k, (map.get(k) || 0) + ms);
    });

    // Again, only the open segment: closed ones are already entries.
    if (includeRunning && state.running && state.running.start) {
      var live = fromDay
        ? sliceForRange({ start: state.running.start, end: Date.now() }, fromDay, toDay)
        : Date.now() - state.running.start;
      if (live > 0) {
        var rk = state.running.activityId || '_none';
        map.set(rk, (map.get(rk) || 0) + live);
      }
    }
    var out = [];
    map.forEach(function (ms, k) {
      if (ms <= 0) return;
      out.push({ activity: activityById(k) || { id: '_none', name: 'Unsorted', color: '#7b849b', icon: '•' }, ms: ms });
    });
    return out.sort(function (a, b) { return b.ms - a.ms; });
  }

  /* First entry overlapping [start, end), ignoring one id and tombstones.

     One timer runs at a time, so overlapping entries mean one of them is
     simply wrong — and left alone they push a day's total past 24 hours. */
  function findOverlap(start, end, ignoreId) {
    return state.entries.find(function (e) {
      if (e.id === ignoreId || e.deleted) return false;
      return e.start < end && e.end > start;
    }) || null;
  }

  /* ═══════════════ ACTIVITIES ═══════════════ */

  function activityById(id) {
    return state.activities.find(function (a) { return a.id === id; }) || null;
  }

  function saveActivity(data) {
    var rec;
    if (data.id) {
      rec = touch(Object.assign({}, activityById(data.id), data));
      state.activities = state.activities.map(function (a) { return a.id === rec.id ? rec : a; });
    } else {
      rec = touch({
        id: uid(), name: data.name, color: data.color || PALETTE[state.activities.length % PALETTE.length],
        icon: data.icon || '•', kind: data.kind || 'neutral',
        archived: false, order: state.activities.length
      });
      state.activities.push(rec);
    }
    return DB.put('activities', rec).then(function () { emit(); return rec; });
  }

  function deleteActivity(id) {
    var rec = activityById(id);
    state.activities = state.activities.filter(function (a) { return a.id !== id; });
    if (!rec) return Promise.resolve();
    return tombstone('activities', rec).then(function () { emit(); });
  }

  /* ═══════════════ TASKS ═══════════════ */

  function taskById(id) {
    return state.tasks.find(function (t) { return t.id === id; }) || null;
  }

  function saveTask(data) {
    var rec;
    if (data.id) {
      rec = touch(Object.assign({}, taskById(data.id), data));
      state.tasks = state.tasks.map(function (t) { return t.id === rec.id ? rec : t; });
    } else {
      rec = touch({
        id: uid(),
        title: data.title,
        notes: data.notes || '',
        activityId: data.activityId || null,
        done: 0,
        createdAt: Date.now(),
        completedAt: null,
        dueDay: data.dueDay || null
      });
      state.tasks.push(rec);
    }
    return DB.put('tasks', rec).then(function () { emit(); return rec; });
  }

  function toggleTask(id) {
    var t = taskById(id);
    if (!t) return Promise.resolve();
    var rec = touch(Object.assign({}, t, {
      done: t.done ? 0 : 1,
      completedAt: t.done ? null : Date.now()
    }));
    state.tasks = state.tasks.map(function (x) { return x.id === id ? rec : x; });

    // Completing the task you're currently timing stops the clock.
    // Silent, because the completion cue below covers it.
    var chain = Promise.resolve();
    if (rec.done && state.running && state.running.taskId === id) chain = stop(true);

    if (global.Sound) Sound.play(rec.done ? 'done' : 'undo');

    return chain.then(function () { return DB.put('tasks', rec); })
                .then(function () { emit(); return rec; });
  }

  function deleteTask(id) {
    var rec = taskById(id);
    state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
    if (!rec) return Promise.resolve();
    var chain = (state.running && state.running.taskId === id) ? stop() : Promise.resolve();
    return chain.then(function () { return tombstone('tasks', rec); }).then(function () { emit(); });
  }

  /* Total time ever logged against a task.

     Only the *open* segment of a running session is added on top: any
     earlier segment was already written as an entry when the timer was
     paused, and adding elapsed() would count that stretch twice. */
  function timeOnTask(id) {
    var ms = state.entries
      .filter(function (e) { return e.taskId === id; })
      .reduce(function (n, e) { return n + durationOf(e); }, 0);
    var r = state.running;
    if (r && r.taskId === id && r.start) ms += Date.now() - r.start;
    return ms;
  }

  /* ═══════════════ HABITS ═══════════════ */

  function habitById(id) {
    return state.habits.find(function (h) { return h.id === id; }) || null;
  }

  function saveHabit(data) {
    var rec;
    if (data.id) {
      rec = touch(Object.assign({}, habitById(data.id), data));
      state.habits = state.habits.map(function (h) { return h.id === rec.id ? rec : h; });
    } else {
      rec = touch({
        id: uid(),
        name: data.name,
        color: data.color || PALETTE[state.habits.length % PALETTE.length],
        icon: data.icon || '◎',
        type: data.type || 'check',          // 'check' | 'timed'
        targetMin: data.targetMin || 0,
        days: data.days || [0, 1, 2, 3, 4, 5, 6],
        activityId: data.activityId || null,
        archived: false,
        createdAt: Date.now()
      });
      state.habits.push(rec);
    }
    return DB.put('habits', rec).then(function () { emit(); return rec; });
  }

  function deleteHabit(id) {
    var rec = habitById(id);
    state.habits = state.habits.filter(function (h) { return h.id !== id; });
    state.checks = state.checks.filter(function (c) { return c.habitId !== id; });
    if (!rec) return Promise.resolve();

    var chain = (state.running && state.running.habitId === id) ? stop() : Promise.resolve();
    return chain
      .then(function () { return tombstone('habits', rec); })
      .then(function () { return DB.where('checks', 'habitId', id); })
      // Its checks are tombstoned too, so the deletion reaches other devices.
      .then(function (rows) {
        return Promise.all(rows.filter(isLive).map(function (c) {
          return tombstone('checks', c);
        }));
      })
      .then(function () { emit(); });
  }

  function isChecked(habitId, day) {
    return state.checks.some(function (c) { return c.habitId === habitId && c.day === day; });
  }

  /* `cue` overrides the sound played — used so hitting a daily target
     sounds like an arrival rather than a plain tick. */
  function toggleCheck(habitId, day, cue, cueDelay) {
    day = day || todayKey();
    var existing = state.checks.find(function (c) { return c.habitId === habitId && c.day === day; });

    // Un-ticking: tombstone it so the change reaches other devices.
    if (existing) {
      state.checks = state.checks.filter(function (c) { return c.id !== existing.id; });
      if (global.Sound) Sound.play('undo');
      return tombstone('checks', existing).then(function () { emit(); });
    }

    if (global.Sound) Sound.play(cue || 'done', cueDelay);

    // Ticking: revive a previous tombstone for this habit/day if there is
    // one. The server holds a unique index on (user_id, habit_id, day) for
    // live rows, so inserting a second id for the same day would be rejected
    // — and would double-count the streak besides.
    return DB.where('checks', 'habitId', habitId).then(function (rows) {
      var prior = rows.find(function (c) { return c.day === day; });
      var rec = prior
        ? touch(Object.assign({}, prior, { deleted: 0, doneAt: Date.now() }))
        : touch({ id: uid(), habitId: habitId, day: day, doneAt: Date.now() });

      state.checks.push(rec);
      return DB.put('checks', rec).then(function () { emit(); return rec; });
    });
  }

  /* Timed habits tick themselves off once the day's target is reached. */
  function maybeAutoCheck(habitId, day) {
    var h = habitById(habitId);
    if (!h || h.type !== 'timed' || !h.targetMin) return Promise.resolve();
    if (isChecked(habitId, day)) return Promise.resolve();
    // Queued behind the stop chime that triggered this.
    if (habitMinutes(habitId, day) >= h.targetMin) return toggleCheck(habitId, day, 'goal', 0.45);
    return Promise.resolve();
  }

  /* Minutes logged against a habit on a given day, including the live
     timer. Sliced to the day so a session over midnight counts on both
     sides, and only the open segment is added — earlier segments of a
     paused session are already entries. */
  function habitMinutes(habitId, day) {
    day = day || todayKey();
    var ms = state.entries
      .filter(function (e) { return e.habitId === habitId; })
      .reduce(function (n, e) { return n + sliceForDay(e, day); }, 0);

    var r = state.running;
    if (r && r.habitId === habitId && r.start) {
      ms += sliceForDay({ start: r.start, end: Date.now() }, day);
    }
    return Math.floor(ms / 60000);
  }

  /* Consecutive scheduled days completed, counting back from today. */
  function habitStreak(habitId) {
    var h = habitById(habitId);
    if (!h) return 0;
    var streak = 0;
    var day = todayKey();

    // Today not being done yet shouldn't break a streak — start from yesterday then.
    if (!isChecked(habitId, day)) day = addDays(day, -1);

    for (var i = 0; i < 730; i++) {
      var d = new Date(day + 'T00:00:00');
      if (h.days.indexOf(d.getDay()) === -1) { day = addDays(day, -1); continue; }
      if (isChecked(habitId, day)) { streak++; day = addDays(day, -1); }
      else break;
    }
    return streak;
  }

  function isScheduledToday(habit) {
    return habit.days.indexOf(new Date().getDay()) !== -1;
  }

  /* ═══════════════ OBJECTIVES ═══════════════ */

  /* An objective is a target over a date window: "Deep work 40h this
     month", "20 study sessions before the exam".

     Progress is never stored — it is recomputed from entries every time.
     That means correcting a session, deleting one, or moving it to
     another day updates the objective immediately and honestly, with no
     counter drifting out of step with the timeline. */

  function objectiveById(id) {
    return state.objectives.find(function (o) { return o.id === id; }) || null;
  }

  function saveObjective(data) {
    var rec;
    if (data.id) {
      rec = touch(Object.assign({}, objectiveById(data.id), data));
      state.objectives = state.objectives.map(function (o) { return o.id === rec.id ? rec : o; });
    } else {
      rec = touch({
        id: uid(),
        title: data.title,
        activityId: data.activityId || null,   // null = any activity
        metric: data.metric || 'hours',        // 'hours' | 'sessions'
        target: data.target,
        fromDay: data.fromDay,
        toDay: data.toDay,
        // `from`/`to` would collide with SQL keywords, hence fromDay/toDay.
        icon: data.icon || '◎',
        achievedAt: null,
        archived: false,
        createdAt: Date.now()
      });
      state.objectives.push(rec);
    }
    return DB.put('objectives', rec)
      .then(function () { return refreshAchievements(); })
      .then(function () { emit(); return rec; });
  }

  function deleteObjective(id) {
    var rec = objectiveById(id);
    state.objectives = state.objectives.filter(function (o) { return o.id !== id; });
    if (!rec) return Promise.resolve();
    return tombstone('objectives', rec).then(function () { emit(); });
  }

  /* Current standing of an objective, all derived. */
  function objectiveProgress(o) {
    var rows = entriesInRange(o.fromDay, o.toDay).filter(function (e) {
      return !o.activityId || e.activityId === o.activityId;
    });

    var value;
    if (o.metric === 'sessions') {
      value = rows.length;
    } else {
      var ms = rows.reduce(function (n, e) {
        return n + sliceForRange(e, o.fromDay, o.toDay);
      }, 0);
      // The open segment counts too, so a running timer moves the bar.
      var r = state.running;
      if (r && r.start && (!o.activityId || r.activityId === o.activityId)) {
        ms += sliceForRange({ start: r.start, end: Date.now() }, o.fromDay, o.toDay);
      }
      value = ms / 3600000;
    }

    var target = o.target || 1;
    var pct = Math.min(100, (value / target) * 100);

    // Where you should be by now if you were spreading it evenly.
    var today = todayKey();
    var totalDays = daysBetween(o.fromDay, o.toDay) + 1;
    var elapsedDays = Math.min(totalDays, Math.max(0, daysBetween(o.fromDay, today) + 1));
    var expectedPct = totalDays > 0 ? (elapsedDays / totalDays) * 100 : 0;

    return {
      value: value,
      target: target,
      pct: pct,
      done: value >= target,
      daysLeft: Math.max(0, daysBetween(today, o.toDay)),
      expired: today > o.toDay,
      // Only meaningful while the window is open.
      onTrack: pct >= expectedPct - 0.001
    };
  }

  function daysBetween(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    var da = new Date(+pa[0], +pa[1] - 1, +pa[2]);
    var db = new Date(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((db - da) / 86400000);
  }

  /* Stamp or clear achievedAt so it matches the numbers.

     Clearing matters: if a session that pushed an objective over the line
     is later deleted or corrected downward, the achievement was never
     really earned, and leaving the badge would be the app lying to you. */
  function refreshAchievements() {
    var changed = [];

    state.objectives.forEach(function (o) {
      var p = objectiveProgress(o);
      if (p.done && !o.achievedAt) {
        changed.push(touch(Object.assign({}, o, { achievedAt: Date.now() })));
      } else if (!p.done && o.achievedAt) {
        changed.push(touch(Object.assign({}, o, { achievedAt: null })));
      }
    });

    if (!changed.length) return Promise.resolve([]);

    var newlyDone = changed.filter(function (o) { return o.achievedAt; });
    state.objectives = state.objectives.map(function (o) {
      var hit = changed.find(function (c) { return c.id === o.id; });
      return hit || o;
    });

    if (newlyDone.length && global.Sound) Sound.play('goal', 0.2);

    return DB.putAll('objectives', changed).then(function () { return newlyDone; });
  }

  function objectivesFor(kind) {
    var today = todayKey();
    return state.objectives.filter(function (o) {
      if (o.archived) return false;
      if (kind === 'achieved') return !!o.achievedAt;
      if (kind === 'missed')   return !o.achievedAt && today > o.toDay;
      return !o.achievedAt && today <= o.toDay;      // active
    }).sort(function (a, b) {
      if (kind === 'achieved') return (b.achievedAt || 0) - (a.achievedAt || 0);
      return a.toDay < b.toDay ? -1 : a.toDay > b.toDay ? 1 : 0;
    });
  }

  /* ═══════════════ INSIGHTS ═══════════════ */

  /* Consecutive days (ending today) with any tracked time. */
  function trackingStreak() {
    var streak = 0;
    var day = todayKey();
    if (totalForDay(day, true) === 0) day = addDays(day, -1);
    for (var i = 0; i < 730; i++) {
      if (totalForDay(day, true) > 0) { streak++; day = addDays(day, -1); }
      else break;
    }
    return streak;
  }

  /* Per-hour totals across a range → 24 buckets of ms.
     Sessions crossing an hour boundary are split proportionally. */
  function hourHistogram(fromDay, toDay) {
    var buckets = new Array(24).fill(0);
    entriesInRange(fromDay, toDay).forEach(function (e) {
      var t = e.start;
      while (t < e.end) {
        var d = new Date(t);
        var hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        var slice = Math.min(hourEnd, e.end) - t;
        buckets[d.getHours()] += slice;
        t += slice;
      }
    });
    return buckets;
  }

  /* [{day, ms}] for the last n days, oldest first. */
  function dailySeries(n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var day = addDays(todayKey(), -i);
      out.push({ day: day, ms: totalForDay(day, true) });
    }
    return out;
  }

  global.Store = {
    state: state, on: on, off: off, emit: emit, init: init, reload: reload,
    uid: uid, dayKey: dayKey, todayKey: todayKey, addDays: addDays,
    touch: touch, isLive: isLive,
    PALETTE: PALETTE, KINDS: KINDS,

    start: start, stop: stop, stopAt: stopAt, discardRunning: discardRunning,
    pause: pause, resume: resume, isPaused: isPaused, sessionStart: sessionStart,
    elapsed: elapsed, runningLabel: runningLabel,
    heartbeat: heartbeat, markWarned: markWarned,

    addManualEntry: addManualEntry, updateEntry: updateEntry, deleteEntry: deleteEntry,
    entryById: entryById, findOverlap: findOverlap,
    entriesForDay: entriesForDay, entriesInRange: entriesInRange,
    durationOf: durationOf, sliceForDay: sliceForDay, sliceForRange: sliceForRange,
    spansDays: spansDays, totalForDay: totalForDay, byActivity: byActivity,
    loadEntries: loadEntries, ensureLoaded: ensureLoaded,

    activityById: activityById, saveActivity: saveActivity, deleteActivity: deleteActivity,

    taskById: taskById, saveTask: saveTask, toggleTask: toggleTask,
    deleteTask: deleteTask, timeOnTask: timeOnTask,

    habitById: habitById, saveHabit: saveHabit, deleteHabit: deleteHabit,
    isChecked: isChecked, toggleCheck: toggleCheck, habitMinutes: habitMinutes,
    habitStreak: habitStreak, isScheduledToday: isScheduledToday,

    objectiveById: objectiveById, saveObjective: saveObjective,
    deleteObjective: deleteObjective, objectiveProgress: objectiveProgress,
    objectivesFor: objectivesFor, refreshAchievements: refreshAchievements,
    daysBetween: daysBetween,

    trackingStreak: trackingStreak, hourHistogram: hourHistogram, dailySeries: dailySeries
  };
})(window);
