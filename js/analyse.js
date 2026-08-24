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

      patterns: {
        busiestHour: fmtHourSlot(pat.bestHour),
        mostProductiveHour: fmtHourSlot(pat.bestProductiveHour),
        busiestWeekday: fmtWeekday(pat.bestWeekday),
        perWeekday: WEEKDAY_NAMES.map(function (name, i) {
          return { day: name, average: fmtDur((pat.weekdayAvg || [])[i]) };
        }),
        sessionCount: pat.sessionCount,
        typicalSession: fmtDur(pat.medianSession),
        longestSession: fmtDur(pat.longestSession)
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
    topTasks: topTasks, findings: findings, summarise: summarise,
    countTrackedDays: countTrackedDays, previousRange: previousRange,
    fmtHours: fmtHours, medianOf: medianOf, change: change
  };
})(window);
