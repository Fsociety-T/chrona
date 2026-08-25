/* ═══════════════════════════════════════════════════════════════
   analyse.js — the analysis engine

   Everything here is computed from your own entries, in the browser,
   with no network. That matters for two reasons: it works offline and
   costs nothing, and it means the AI layer never has to be told raw
   history — it is handed this summary instead, which is smaller,
   cheaper, and gives away far less than a dump of every session.

   Every number traces back to entries, so correcting a session
   changes the analysis immediately — same rule as objectives.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var S = null;   // bound at first use, so load order doesn't matter
  function store() { return S || (S = global.Store); }

  var HOUR = 3600000;
  var MIN = 60000;

  /* Pausing writes the open segment and starts a new one, so one session
     with a coffee break is stored as two entries. Merging them back below
     this gap is what makes "longest block" mean focus rather than how
     often you remember to hit pause. Three minutes lets a refill through
     and keeps a lunch break out. */
  var GAP_TOLERANCE = 3 * MIN;

  /* Where a block stops being a stretch of work and starts being a real
     run at something. Arbitrary, but it has to be *some* number, and 45
     minutes is long enough that fragmenting it is visible. */
  var DEEP_MIN = 45 * MIN;

  /* How long your day is, for "how much of it did I record". Sleep is
     excluded, so the figure describes the part you could have tracked. */
  var DEFAULT_WAKING_HOURS = 16;
  var LS_WAKING = 'chrona:waking';

  function wakingHours() {
    var n;
    try { n = parseInt(localStorage.getItem(LS_WAKING), 10); } catch (e) { /* blocked */ }
    return n > 0 && n <= 24 ? n : DEFAULT_WAKING_HOURS;
  }

  function setWakingHours(n) {
    n = parseInt(n, 10);
    if (!(n > 0 && n <= 24)) return;
    try { localStorage.setItem(LS_WAKING, String(n)); } catch (e) { /* blocked */ }
  }

  /* ── helpers ──────────────────────────────────────────────── */

  function rangeDays(days) {
    var S = store();
    var to = S.todayKey();
    return { from: S.addDays(to, -(days - 1)), to: to };
  }

  /* The window of the same length immediately before a range —
     what "vs last week" compares against. */
  function previousRange(from, to) {
    var S = store();
    var len = S.daysBetween(from, to) + 1;
    return { from: S.addDays(from, -len), to: S.addDays(from, -1) };
  }

  function totalIn(fromDay, toDay) {
    var S = store();
    return S.entriesInRange(fromDay, toDay).reduce(function (n, e) {
      return n + S.sliceForRange(e, fromDay, toDay);
    }, 0);
  }

  /* Percentage change, guarding the divide-by-zero that makes
     "up ∞%" appear the first week anything is tracked. */
  function change(now, before) {
    if (!before) return now > 0 ? null : 0;   // null = "no baseline"
    return ((now - before) / before) * 100;
  }

  /* ── 1. Am I improving? ───────────────────────────────────── */

  function comparePeriods(days) {
    var S = store();
    var cur = rangeDays(days);
    var prev = previousRange(cur.from, cur.to);

    var nowTotal = totalIn(cur.from, cur.to);
    var beforeTotal = totalIn(prev.from, prev.to);

    /* Per activity, both windows, so the movers can be named. */
    var nowBy = {}, beforeBy = {};
    S.byActivity(S.entriesInRange(cur.from, cur.to), false, cur.from, cur.to)
      .forEach(function (g) { nowBy[g.activity.id] = g.ms; });
    S.byActivity(S.entriesInRange(prev.from, prev.to), false, prev.from, prev.to)
      .forEach(function (g) { beforeBy[g.activity.id] = g.ms; });

    var ids = Object.keys(nowBy).concat(Object.keys(beforeBy))
      .filter(function (v, i, a) { return a.indexOf(v) === i; });

    var movers = ids.map(function (id) {
      var a = S.activityById(id) || { id: id, name: 'Unsorted', color: '#7b849b', icon: '•', kind: 'neutral' };
      return {
        activity: a,
        now: nowBy[id] || 0,
        before: beforeBy[id] || 0,
        delta: (nowBy[id] || 0) - (beforeBy[id] || 0)
      };
    }).sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });

    return {
      days: days,
      current: cur, previous: prev,
      now: nowTotal, before: beforeTotal,
      delta: nowTotal - beforeTotal,
      pct: change(nowTotal, beforeTotal),
      movers: movers,
      daysTracked: countTrackedDays(cur.from, cur.to),
      daysTrackedBefore: countTrackedDays(prev.from, prev.to)
    };
  }

  function countTrackedDays(fromDay, toDay) {
    var S = store();
    var n = 0;
    for (var d = fromDay; d <= toDay; d = S.addDays(d, 1)) {
      if (S.totalForDay(d, false) > 0) n++;
    }
    return n;
  }

  /* ── 2. Where does it actually go? ────────────────────────── */

  function split(fromDay, toDay) {
    var S = store();
    var out = { productive: 0, neutral: 0, draining: 0, total: 0 };

    S.byActivity(S.entriesInRange(fromDay, toDay), false, fromDay, toDay)
      .forEach(function (g) {
        var kind = g.activity.kind || 'neutral';
        if (out[kind] === undefined) kind = 'neutral';
        out[kind] += g.ms;
        out.total += g.ms;
      });

    out.productivePct = out.total ? (out.productive / out.total) * 100 : 0;
    out.drainingPct = out.total ? (out.draining / out.total) * 100 : 0;
    return out;
  }

  /* Time per task, biggest first — what the hours actually went into. */
  function topTasks(fromDay, toDay, limit) {
    var S = store();
    var map = new Map();

    S.entriesInRange(fromDay, toDay).forEach(function (e) {
      if (!e.taskId) return;
      var ms = S.sliceForRange(e, fromDay, toDay);
      map.set(e.taskId, (map.get(e.taskId) || 0) + ms);
    });

    var out = [];
    map.forEach(function (ms, id) {
      var t = S.taskById(id);
      if (t) out.push({ task: t, ms: ms, done: !!t.done });
    });
    return out.sort(function (a, b) { return b.ms - a.ms; }).slice(0, limit || 5);
  }

  /* ── 3. When am I at my best? ─────────────────────────────── */

  function patterns(fromDay, toDay) {
    var S = store();

    /* Hour of day — reuse the histogram the heatmap already builds. */
    var hours = S.hourHistogram(fromDay, toDay);
    var bestHour = hours.indexOf(Math.max.apply(null, hours));

    /* The same, but only for activities marked productive: your peak
       hour for scrolling is not the answer to "when am I at my best". */
    var prodHours = new Array(24).fill(0);
    S.entriesInRange(fromDay, toDay).forEach(function (e) {
      var a = S.activityById(e.activityId);
      if (!a || a.kind !== 'productive') return;
      var t = e.start;
      while (t < e.end) {
        var d = new Date(t);
        var hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        var slice = Math.min(hourEnd, e.end) - t;
        prodHours[d.getHours()] += slice;
        t += slice;
      }
    });
    var peakProductive = Math.max.apply(null, prodHours);
    var bestProductiveHour = peakProductive > 0 ? prodHours.indexOf(peakProductive) : null;

    /* Weekday totals, averaged over how many of each weekday the
       window actually contains — otherwise a 10-day range flatters
       whichever weekdays it happens to include twice. */
    var byWeekday = new Array(7).fill(0);
    var weekdayCounts = new Array(7).fill(0);
    for (var d2 = fromDay; d2 <= toDay; d2 = S.addDays(d2, 1)) {
      var wd = new Date(d2 + 'T00:00:00').getDay();
      byWeekday[wd] += S.totalForDay(d2, false);
      weekdayCounts[wd]++;
    }
    var weekdayAvg = byWeekday.map(function (ms, i) {
      return weekdayCounts[i] ? ms / weekdayCounts[i] : 0;
    });
    var bestWeekday = weekdayAvg.indexOf(Math.max.apply(null, weekdayAvg));

    /* Session shape. */
    var sessions = S.entriesInRange(fromDay, toDay);
    var durations = sessions.map(function (e) { return S.durationOf(e); });
    var median = medianOf(durations);
    var longest = durations.length ? Math.max.apply(null, durations) : 0;

    return {
      hours: hours,
      productiveHours: prodHours,
      bestHour: bestHour,
      bestProductiveHour: bestProductiveHour,
      weekdayAvg: weekdayAvg,
      bestWeekday: bestWeekday,
      sessionCount: sessions.length,
      medianSession: median,
      longestSession: longest,
      avgPerTrackedDay: (function () {
        var tracked = countTrackedDays(fromDay, toDay);
        return tracked ? totalIn(fromDay, toDay) / tracked : 0;
      })()
    };
  }

  function medianOf(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  /* ── 3b. The shape of the time ────────────────────────────────

     Everything above measures how much time went where. None of it can
     tell four hours in two sittings from four hours in fourteen, which
     are the same number and completely different days. These do.

     They are all built on blocks rather than entries, because an entry
     is a segment: pausing ends one and starts another, so counting
     entries measures how often you pause. */

  /* Consecutive entries on the same activity, separated by less than
     GAP_TOLERANCE, are one block. */
  function blocks(fromDay, toDay) {
    var S = store();
    var rows = S.entriesInRange(fromDay, toDay)
      .slice()
      .sort(function (a, b) { return a.start - b.start; });

    var out = [];
    rows.forEach(function (e) {
      var last = out[out.length - 1];
      if (last && last.activityId === e.activityId && e.start - last.end <= GAP_TOLERANCE) {
        last.end = Math.max(last.end, e.end);
        last.ms = last.end - last.start;
        last.segments++;
        return;
      }
      out.push({
        activityId: e.activityId,
        start: e.start,
        end: e.end,
        ms: S.durationOf(e),
        segments: 1
      });
    });
    return out;
  }

  function isProductive(activityId) {
    var a = store().activityById(activityId);
    return !!(a && a.kind === 'productive');
  }

  function focus(fromDay, toDay) {
    var S = store();
    var all = blocks(fromDay, toDay);
    var prod = all.filter(function (b) { return isProductive(b.activityId); });

    var productiveMs = prod.reduce(function (n, b) { return n + b.ms; }, 0);
    var deepMs = prod.reduce(function (n, b) { return b.ms >= DEEP_MIN ? n + b.ms : n; }, 0);

    /* Switches are counted per day and taken as a median. A single
       scattered day would otherwise set the number for the whole window. */
    var perDay = [];
    for (var d = fromDay; d <= toDay; d = S.addDays(d, 1)) {
      var dayBlocks = blocks(d, d);
      if (!dayBlocks.length) continue;            // untracked days say nothing
      var switches = 0;
      for (var i = 1; i < dayBlocks.length; i++) {
        if (dayBlocks[i].activityId !== dayBlocks[i - 1].activityId) switches++;
      }
      perDay.push(switches);
    }

    return {
      blockCount: all.length,
      medianBlock: medianOf(all.map(function (b) { return b.ms; })),
      longestBlock: all.length ? Math.max.apply(null, all.map(function (b) { return b.ms; })) : 0,

      productiveMs: productiveMs,
      productiveBlocks: prod.length,
      longestProductiveBlock: prod.length ? Math.max.apply(null, prod.map(function (b) { return b.ms; })) : 0,

      /* null rather than 0 when there is nothing to divide by. Zero reads
         as "you did badly"; absent reads as "nothing to say yet", which is
         the truth and the same rule the baseline floor follows. */
      deepWorkPct: productiveMs > 0 ? (deepMs / productiveMs) * 100 : null,
      blocksPerProductiveHour: productiveMs > 0
        ? prod.length / (productiveMs / HOUR)
        : null,
      switchesPerDay: perDay.length ? medianOf(perDay) : null
    };
  }

  /* When the day actually begins and ends, as minutes from midnight.
     Median, so one 04:00 start does not redefine your mornings. */
  function rhythm(fromDay, toDay) {
    var S = store();
    var firsts = [], lasts = [];

    for (var d = fromDay; d <= toDay; d = S.addDays(d, 1)) {
      var rows = S.entriesForDay(d);
      if (!rows.length) continue;

      var bounds = rows.reduce(function (acc, e) {
        return { start: Math.min(acc.start, e.start), end: Math.max(acc.end, e.end) };
      }, { start: Infinity, end: -Infinity });

      firsts.push(minutesInto(bounds.start, d));
      lasts.push(minutesInto(bounds.end, d));
    }

    return {
      startsAt: firsts.length ? Math.round(medianOf(firsts)) : null,
      endsAt: lasts.length ? Math.round(medianOf(lasts)) : null,
      days: firsts.length
    };
  }

  /* Minutes from that day's midnight. A session running past midnight is
     clamped to the end of the day rather than wrapping to a small number,
     which would read as an absurdly early finish. */
  function minutesInto(ts, day) {
    var midnight = new Date(day + 'T00:00:00').getTime();
    return Math.max(0, Math.min(24 * 60, Math.round((ts - midnight) / MIN)));
  }

  /* ── 3c. How much of the day is even recorded? ────────────────

     Without this, "100% productive" can describe three hours of a
     sixteen-hour day and sound like a complete account of it. */
  function coverage(fromDay, toDay) {
    var S = store();
    var waking = wakingHours();
    var dayMs = waking * HOUR;

    var tracked = countTrackedDays(fromDay, toDay);
    var total = totalIn(fromDay, toDay);
    var perDay = tracked ? total / tracked : 0;
    var windowDays = S.daysBetween(fromDay, toDay) + 1;

    var raw = dayMs ? (perDay / dayMs) * 100 : 0;

    return {
      wakingHours: waking,
      trackedPerDay: perDay,
      unaccounted: Math.max(0, dayMs - perDay),
      /* Tracking sleep as an activity legitimately pushes this past the
         waking day, so cap it and flag it rather than printing 130%,
         which looks like arithmetic gone wrong. */
      perTrackedDayPct: Math.min(100, raw),
      overFull: raw > 100,
      windowPct: windowDays && dayMs ? Math.min(100, (total / (windowDays * dayMs)) * 100) : 0,
      daysTracked: tracked,
      daysInWindow: windowDays
    };
  }

  /* ── 4. What should I change? ─────────────────────────────── */

  /* Findings, most actionable first. Each carries a severity so the UI
     can lead with what matters rather than the first thing computed. */
  function findings(days) {
    var S = store();
    var cmp = comparePeriods(days);
    var cur = cmp.current;
    var sp = split(cur.from, cur.to);
    var pat = patterns(cur.from, cur.to);
    var out = [];

    /* Habits whose streak is alive but which are being missed lately. */
    S.state.habits.filter(function (h) { return !h.archived; }).forEach(function (h) {
      var scheduled = 0, done = 0;
      for (var d = cur.from; d <= cur.to; d = S.addDays(d, 1)) {
        var wd = new Date(d + 'T00:00:00').getDay();
        if (h.days.indexOf(wd) === -1) continue;
        scheduled++;
        if (S.isChecked(h.id, d)) done++;
      }
      if (!scheduled) return;
      var rate = done / scheduled;
      if (rate < 0.5) {
        out.push({
          severity: rate < 0.25 ? 'high' : 'medium',
          kind: 'habit-slipping',
          title: h.name + ' is slipping',
          detail: done + ' of ' + scheduled + ' scheduled days in the last ' + days +
                  ' days. Current streak ' + S.habitStreak(h.id) + '.',
          habitId: h.id
        });
      }
    });

    /* Objectives that will not land at the current pace. */
    S.objectivesFor('active').forEach(function (o) {
      var p = S.objectiveProgress(o);
      if (p.onTrack || p.daysLeft === 0) return;
      var remaining = Math.max(0, p.target - p.value);
      var perDay = p.daysLeft ? remaining / p.daysLeft : remaining;
      out.push({
        severity: p.pct < 25 && p.daysLeft <= 7 ? 'high' : 'medium',
        kind: 'objective-behind',
        title: o.title + ' is behind pace',
        detail: Math.round(p.pct) + '% done with ' + p.daysLeft + ' day' +
                (p.daysLeft === 1 ? '' : 's') + ' left — needs about ' +
                fmtNum(perDay) + (o.metric === 'sessions' ? ' sessions' : 'h') + ' a day from here.',
        objectiveId: o.id
      });
    });

    /* Draining time worth naming. */
    if (sp.total > 0 && sp.drainingPct >= 25) {
      out.push({
        severity: sp.drainingPct >= 40 ? 'high' : 'medium',
        kind: 'draining-share',
        title: Math.round(sp.drainingPct) + '% of tracked time is on draining activities',
        detail: fmtHours(sp.draining) + ' of ' + fmtHours(sp.total) + ' in the last ' + days + ' days.'
      });
    }

    /* A real drop in overall tracked time. */
    if (cmp.pct !== null && cmp.pct <= -25 && cmp.before > 2 * HOUR) {
      out.push({
        severity: 'medium',
        kind: 'tracking-down',
        title: 'Tracked time is down ' + Math.abs(Math.round(cmp.pct)) + '%',
        detail: fmtHours(cmp.now) + ' this period vs ' + fmtHours(cmp.before) + ' last.'
      });
    }

    /* Productive time arriving in scraps. Gated on there being enough of
       it to have a shape at all — three blocks in twenty minutes is not a
       fragmentation problem, it is a short day. */
    var fq = focus(cur.from, cur.to);
    if (fq.blocksPerProductiveHour !== null && fq.blocksPerProductiveHour >= 3 && fq.productiveMs >= HOUR) {
      out.push({
        severity: 'medium',
        kind: 'fragmented',
        title: 'Your productive time arrives in pieces',
        detail: fq.productiveBlocks + ' separate blocks across ' + fmtHours(fq.productiveMs) +
                ' — about ' + fmtNum(fq.blocksPerProductiveHour) + ' an hour. Longest unbroken stretch was ' +
                fmtHours(fq.longestProductiveBlock) + '.'
      });
    }

    /* A win worth naming: long stretches are the hard part. */
    if (fq.deepWorkPct !== null && fq.deepWorkPct >= 60 && fq.productiveMs >= HOUR) {
      out.push({
        severity: 'good',
        kind: 'deep-work',
        title: Math.round(fq.deepWorkPct) + '% of your productive time came in long blocks',
        detail: 'Blocks of 45 minutes or more. Longest was ' + fmtHours(fq.longestProductiveBlock) + '.'
      });
    }

    /* Scope, not failure. Every percentage above describes only the part
       of the day that was recorded, and this says how big that part is. */
    var cov = coverage(cur.from, cur.to);
    if (cov.daysTracked > 0 && cov.perTrackedDayPct < 25) {
      out.push({
        severity: 'low',
        kind: 'low-coverage',
        title: 'Only ' + Math.round(cov.perTrackedDayPct) + '% of your day is recorded',
        detail: fmtHours(cov.trackedPerDay) + ' of a ' + cov.wakingHours + 'h day on the days you tracked. ' +
                'The splits above describe that part, not the whole day.'
      });
    }

    /* Consistency — showing up matters more than any single big day. */
    if (cmp.daysTracked && cmp.daysTracked < Math.ceil(days * 0.5)) {
      out.push({
        severity: 'low',
        kind: 'consistency',
        title: 'Only tracked on ' + cmp.daysTracked + ' of ' + days + ' days',
        detail: 'The gaps make trends hard to read — the numbers above only cover the days you tracked.'
      });
    }

    /* Wins are findings too — an analysis that only scolds gets ignored. */
    cmp.movers.slice(0, 3).forEach(function (m) {
      if (m.activity.kind === 'productive' && m.delta > 0 && m.before > 0 && m.delta > 30 * 60000) {
        out.push({
          severity: 'good',
          kind: 'improving',
          title: m.activity.name + ' is up ' + fmtHours(m.delta),
          detail: fmtHours(m.now) + ' this period vs ' + fmtHours(m.before) + ' last.'
        });
      }
      if (m.activity.kind === 'draining' && m.delta < 0 && Math.abs(m.delta) > 30 * 60000) {
        out.push({
          severity: 'good',
          kind: 'improving',
          title: m.activity.name + ' is down ' + fmtHours(Math.abs(m.delta)),
          detail: fmtHours(m.now) + ' this period vs ' + fmtHours(m.before) + ' last.'
        });
      }
    });

    var order = { high: 0, medium: 1, low: 2, good: 3 };
    return out.sort(function (a, b) { return order[a.severity] - order[b.severity]; });
  }

  function fmtHours(ms) {
    var h = ms / HOUR;
    if (h < 1) return Math.round(ms / 60000) + 'm';
    return (h < 10 ? Math.round(h * 10) / 10 : Math.round(h)) + 'h';
  }
  function fmtNum(n) { return Math.round(n * 10) / 10; }

  /* ── shaping the summary for a reader ─────────────────────── */

  /* Everything below exists because a model reports the numbers it is
     handed. Give it 951573 and it writes "951,573 ms" — technically the
     truth, useless to read, and it buries the fact that this is sixteen
     minutes. None of these values are used for arithmetic downstream, so
     they are formatted here rather than passed raw and explained later. */

  var WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
                       'Thursday', 'Friday', 'Saturday'];

  function fmtDur(ms) {
    ms = Math.max(0, Math.round(ms || 0));
    var mins = Math.round(ms / 60000);
    if (mins < 1) return ms > 0 ? 'under a minute' : 'none';
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  /* Minutes from midnight → "14:10". */
  function fmtClockMin(min) {
    if (min === null || min === undefined) return null;
    var h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function fmtHourSlot(h) {
    if (h === null || h === undefined || h < 0) return null;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(h) + ':00-' + pad((h + 1) % 24) + ':00';
  }

  function fmtWeekday(i) {
    return (i === null || i === undefined || i < 0) ? null : WEEKDAY_NAMES[i];
  }

  /* A percentage is only meaningful against a baseline worth dividing by.
     Five minutes last week becoming sixteen this week is not "+17,730%",
     it is two small numbers — and stating it as a percentage invents a
     trend out of noise. Below the floor, say what actually happened. */
  var BASELINE_FLOOR = 15 * 60000;

  function fmtChange(now, before) {
    if (!before) return 'nothing tracked in the previous window';
    if (before < BASELINE_FLOOR) {
      var had = fmtDur(before);
      return (had === 'under a minute' ? had : 'only ' + had) +
             ' in the previous window - too little to compare against';
    }
    var pct = Math.round(((now - before) / before) * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }

  /* ── the whole picture, in one object ─────────────────────── */

  /* This is also exactly what gets sent to the AI layer — a summary,
     never the raw history. */
  function summarise(days) {
    var S = store();
    var cmp = comparePeriods(days);
    var cur = cmp.current;
    var sp = split(cur.from, cur.to);
    var pat = patterns(cur.from, cur.to);
    var fq = focus(cur.from, cur.to);
    var rhy = rhythm(cur.from, cur.to);
    var cov = coverage(cur.from, cur.to);

    return {
      generatedAt: new Date().toISOString(),
      window: { days: days, from: cur.from, to: cur.to },

      note: 'All durations are already formatted for a reader. Quote them exactly as written.',

      totals: {
        tracked: fmtDur(cmp.now),
        trackedPrevious: fmtDur(cmp.before),
        change: fmtChange(cmp.now, cmp.before),
        daysTracked: cmp.daysTracked,
        daysInWindow: days,
        avgPerTrackedDay: fmtDur(pat.avgPerTrackedDay)
      },

      split: {
        productive: fmtDur(sp.productive),
        neutral: fmtDur(sp.neutral),
        draining: fmtDur(sp.draining),
        productivePct: sp.productivePct,
        drainingPct: sp.drainingPct
      },

      activities: cmp.movers.map(function (m) {
        return {
          name: m.activity.name,
          kind: m.activity.kind || 'neutral',
          time: fmtDur(m.now),
          previously: fmtDur(m.before),
          change: fmtChange(m.now, m.before)
        };
      }),

      /* How much of the day these numbers actually describe. Without it a
         model can report "100% productive" as though it covered the day,
         when it may cover three hours of sixteen. */
      coverage: {
        dayLength: cov.wakingHours + 'h',
        recordedPerTrackedDay: fmtDur(cov.trackedPerDay),
        unrecordedPerTrackedDay: fmtDur(cov.unaccounted),
        shareOfDayRecorded: Math.round(cov.perTrackedDayPct) + '%',
        note: cov.overFull
          ? 'More time is tracked than the stated day length, so the share is capped at 100%.'
          : 'Every split and percentage below describes only the recorded part of the day.'
      },

      /* The shape of the time, which the totals cannot show. */
      focus: {
        longestUnbrokenBlock: fmtDur(fq.longestBlock),
        longestProductiveBlock: fmtDur(fq.longestProductiveBlock),
        typicalBlock: fmtDur(fq.medianBlock),
        blockCount: fq.blockCount,
        productiveInLongBlocks: fq.deepWorkPct === null
          ? 'no productive time in this window'
          : Math.round(fq.deepWorkPct) + '% of productive time came in blocks of 45 min or more',
        fragmentation: fq.blocksPerProductiveHour === null
          ? 'no productive time to measure'
          : fmtNum(fq.blocksPerProductiveHour) + ' separate blocks per productive hour',
        activitySwitchesPerDay: fq.switchesPerDay === null ? 'nothing tracked' : fq.switchesPerDay,
        note: 'A block is continuous work on one activity; pausing briefly does not split it.'
      },

      rhythm: {
        dayUsuallyStarts: fmtClockMin(rhy.startsAt) || 'nothing tracked',
        dayUsuallyEnds: fmtClockMin(rhy.endsAt) || 'nothing tracked',
        basedOnDays: rhy.days
      },

      patterns: {
        busiestHour: fmtHourSlot(pat.bestHour),
        mostProductiveHour: fmtHourSlot(pat.bestProductiveHour),
        busiestWeekday: fmtWeekday(pat.bestWeekday),
        perWeekday: WEEKDAY_NAMES.map(function (name, i) {
          return { day: name, average: fmtDur((pat.weekdayAvg || [])[i]) };
        }),
        /* Blocks, not entries. Pausing writes a segment and starts a new
           one, so entry counts measure how often you pause — a reader who
           asks about sessions means the uninterrupted stretch. */
        sessionCount: fq.blockCount,
        typicalSession: fmtDur(fq.medianBlock),
        longestSession: fmtDur(fq.longestBlock)
      },

      tasks: topTasks(cur.from, cur.to, 5).map(function (t) {
        return { title: t.task.title, time: fmtDur(t.ms), done: t.done };
      }),

      habits: S.state.habits.filter(function (h) { return !h.archived; }).map(function (h) {
        var scheduled = 0, done = 0;
        for (var d = cur.from; d <= cur.to; d = S.addDays(d, 1)) {
          var wd = new Date(d + 'T00:00:00').getDay();
          if (h.days.indexOf(wd) === -1) continue;
          scheduled++;
          if (S.isChecked(h.id, d)) done++;
        }
        return {
          name: h.name, type: h.type, targetMin: h.targetMin,
          streak: S.habitStreak(h.id), scheduled: scheduled, completed: done
        };
      }),

      objectives: S.objectivesFor('active').map(function (o) {
        var p = S.objectiveProgress(o);
        return {
          title: o.title, metric: o.metric, target: o.target,
          value: Math.round(p.value * 100) / 100,
          pct: Math.round(p.pct),
          daysLeft: p.daysLeft, onTrack: p.onTrack
        };
      }),

      findings: findings(days).map(function (f) {
        return { severity: f.severity, kind: f.kind, title: f.title, detail: f.detail };
      })
    };
  }

  global.Analyse = {
    comparePeriods: comparePeriods, split: split, patterns: patterns,
    blocks: blocks, focus: focus, rhythm: rhythm, coverage: coverage,
    wakingHours: wakingHours, setWakingHours: setWakingHours,
    topTasks: topTasks, findings: findings, summarise: summarise,
    countTrackedDays: countTrackedDays, previousRange: previousRange,
    fmtHours: fmtHours, fmtDur: fmtDur, fmtClockMin: fmtClockMin,
    fmtNumShort: fmtNum,
    medianOf: medianOf, change: change
  };
})(window);
