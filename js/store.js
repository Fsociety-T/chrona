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

  var DEFAULT_ACTIVITIES = [
    { name: 'Deep work', color: '#6c8cff', icon: '🎯' },
    { name: 'Study',     color: '#22c9a8', icon: '📚' },
    { name: 'Exercise',  color: '#f5a524', icon: '🏃' },
    { name: 'Rest',      color: '#a97bff', icon: '🌙' },
    { name: 'Scrolling', color: '#f2557a', icon: '📱' }
  ];

  /* ── in-memory state ──────────────────────────────────────── */
  var state = {
    activities: [],
    entries: [],     // recent window only (loaded per range)
    tasks: [],
    habits: [],
    checks: [],
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
      DB.all('checks'), DB.get('meta', 'running')
    ]).then(function (res) {
      state.activities = res[0].filter(isLive).sort(function (a, b) { return a.order - b.order; });
      state.tasks   = res[1].filter(isLive);
      state.habits  = res[2].filter(isLive);
      state.checks  = res[3].filter(isLive);
      state.running = res[4] ? res[4].value : null;
      return loadEntries(addDays(todayKey(), -120), todayKey());
    });
  }

  function seedActivities() {
    var recs = DEFAULT_ACTIVITIES.map(function (a, i) {
      return touch({ id: uid(), name: a.name, color: a.color, icon: a.icon, archived: false, order: i });
    });
    state.activities = recs;
    return DB.putAll('activities', recs);
  }

  /* Load entries for a day range into memory. */
  function loadEntries(fromDay, toDay) {
    return DB.range('entries', 'day', fromDay, toDay).then(function (rows) {
      state.entries = rows.filter(isLive).sort(function (a, b) { return a.start - b.start; });
      return state.entries;
    });
  }

  /* ═══════════════ TIMER ENGINE ═══════════════ */

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
        start: Date.now()
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

  /* Stop the running timer and write it as an entry.
     Sessions under 5s are discarded as mis-taps. */
  function stop(silent) {
    if (!state.running) return Promise.resolve(null);
    if (!silent && global.Sound) Sound.play('stop');
    var r = state.running;
    var end = Date.now();
    state.running = null;

    return DB.put('meta', { key: 'running', value: null }).then(function () {
      if (end - r.start < 5000) { emit(); return null; }

      var entry = touch({
        id: uid(),
        activityId: r.activityId,
        taskId: r.taskId,
        habitId: r.habitId,
        note: r.note || '',
        start: r.start,
        end: end,
        day: dayKey(r.start)
      });
      state.entries.push(entry);
      state.entries.sort(function (a, b) { return a.start - b.start; });

      return DB.put('entries', entry).then(function () {
        // A timed habit auto-completes once its daily target is met.
        if (entry.habitId) return maybeAutoCheck(entry.habitId, entry.day);
      }).then(function () {
        emit();
        return entry;
      });
    });
  }

  function elapsed() {
    return state.running ? Date.now() - state.running.start : 0;
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
    }).then(function () { emit(); return entry; });
  }

  function deleteEntry(id) {
    var rec = state.entries.find(function (e) { return e.id === id; });
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    if (!rec) return Promise.resolve();
    return tombstone('entries', rec).then(function () { emit(); });
  }

  function entriesForDay(day) {
    return state.entries.filter(function (e) { return e.day === day; });
  }

  function entriesInRange(fromDay, toDay) {
    return state.entries.filter(function (e) { return e.day >= fromDay && e.day <= toDay; });
  }

  function durationOf(e) { return Math.max(0, e.end - e.start); }

  /* Total ms tracked on a day, optionally including the live timer. */
  function totalForDay(day, includeRunning) {
    var sum = entriesForDay(day).reduce(function (n, e) { return n + durationOf(e); }, 0);
    if (includeRunning && state.running && dayKey(state.running.start) === day) {
      sum += elapsed();
    }
    return sum;
  }

  /* Group a set of entries by activity → [{activity, ms}] sorted desc. */
  function byActivity(entries, includeRunning) {
    var map = new Map();
    entries.forEach(function (e) {
      var k = e.activityId || '_none';
      map.set(k, (map.get(k) || 0) + durationOf(e));
    });
    if (includeRunning && state.running) {
      var rk = state.running.activityId || '_none';
      map.set(rk, (map.get(rk) || 0) + elapsed());
    }
    var out = [];
    map.forEach(function (ms, k) {
      out.push({ activity: activityById(k) || { id: '_none', name: 'Unsorted', color: '#7b849b', icon: '•' }, ms: ms });
    });
    return out.sort(function (a, b) { return b.ms - a.ms; });
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
        icon: data.icon || '•', archived: false, order: state.activities.length
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

  /* Total time ever logged against a task. */
  function timeOnTask(id) {
    var ms = state.entries
      .filter(function (e) { return e.taskId === id; })
      .reduce(function (n, e) { return n + durationOf(e); }, 0);
    if (state.running && state.running.taskId === id) ms += elapsed();
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

  /* Minutes logged against a habit on a given day (includes live timer). */
  function habitMinutes(habitId, day) {
    day = day || todayKey();
    var ms = state.entries
      .filter(function (e) { return e.habitId === habitId && e.day === day; })
      .reduce(function (n, e) { return n + durationOf(e); }, 0);
    if (state.running && state.running.habitId === habitId && dayKey(state.running.start) === day) {
      ms += elapsed();
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
    PALETTE: PALETTE,

    start: start, stop: stop, elapsed: elapsed, runningLabel: runningLabel,

    addManualEntry: addManualEntry, deleteEntry: deleteEntry,
    entriesForDay: entriesForDay, entriesInRange: entriesInRange,
    durationOf: durationOf, totalForDay: totalForDay, byActivity: byActivity,
    loadEntries: loadEntries,

    activityById: activityById, saveActivity: saveActivity, deleteActivity: deleteActivity,

    taskById: taskById, saveTask: saveTask, toggleTask: toggleTask,
    deleteTask: deleteTask, timeOnTask: timeOnTask,

    habitById: habitById, saveHabit: saveHabit, deleteHabit: deleteHabit,
    isChecked: isChecked, toggleCheck: toggleCheck, habitMinutes: habitMinutes,
    habitStreak: habitStreak, isScheduledToday: isScheduledToday,

    trackingStreak: trackingStreak, hourHistogram: hourHistogram, dailySeries: dailySeries
  };
})(window);
