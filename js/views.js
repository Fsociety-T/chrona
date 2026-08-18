/* ═══════════════════════════════════════════════════════════════
   views.js — rendering for Today, Tasks, Habits, Insights,
   plus every sheet/form the app opens.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var $ = UI.$, el = UI.el, clear = UI.clear;
  var S = Store;

  var ICONS = ['🎯','📚','💻','🏃','🧘','🍳','🌙','📱','🎨','✍️','🎵','🧹','💬','🚗','☕','🛒','💤','🧠','🏋️','📖'];

  var DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  /* svg check mark used in checkboxes */
  function checkSvg() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '3.2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M5 13l4.5 4.5L19 7');
    s.appendChild(p);
    return s;
  }

  function playSvg(isLive) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '15'); s.setAttribute('height', '15');
    var p = document.createElementNS('http://www.w3.org/2000/svg', isLive ? 'rect' : 'path');
    if (isLive) {
      p.setAttribute('x', '6'); p.setAttribute('y', '6');
      p.setAttribute('width', '12'); p.setAttribute('height', '12');
      p.setAttribute('rx', '2.5');
    } else {
      p.setAttribute('d', 'M8 5.6v12.8a1 1 0 0 0 1.54.84l9.2-6.4a1 1 0 0 0 0-1.68l-9.2-6.4A1 1 0 0 0 8 5.6z');
    }
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  }

  /* ══════════════════════ TODAY ══════════════════════ */

  /* Which day the Today screen is showing. Defaults to today; paging back
     lets you review and correct a day after the fact. */
  var viewDay = null;

  function currentDay() { return viewDay || S.todayKey(); }
  function isToday() { return currentDay() === S.todayKey(); }

  function goToDay(day) {
    var today = S.todayKey();
    if (day > today) day = today;
    viewDay = day;
    // Paging past the loaded window would otherwise show an empty day
    // that actually has entries sitting in the database.
    S.ensureLoaded(day).then(renderToday);
    renderToday();
  }

  function resetDay() { viewDay = null; }

  function renderToday() {
    var day = currentDay();
    var today = S.todayKey();
    var onToday = day === today;

    $('#todayDate').textContent = UI.fmtDayLong(day);
    $('#todayTitle').textContent = onToday ? 'Today'
      : day === S.addDays(today, -1) ? 'Yesterday'
      : UI.fmtDayLong(day).split(',')[0];

    $('#dayNext').disabled = onToday;
    $('#dayToday').hidden = onToday;
    $('#totalsTitle').textContent = onToday ? 'Where today went' : 'Where the day went';

    // The timer, quick-start chips and the sign-in prompt are all about
    // *now* — they'd be misleading sitting above a past day.
    $('#timerCard').hidden = !onToday;
    $('#quickStartSection').hidden = !onToday;

    if (onToday) {
      renderTimerCard();
      renderQuickChips();
    }
    renderSyncBanner();
    renderTodayTotals(day);
    renderTimeline(day);
  }

  /* The banner and the header badge both exist so that "not backed up"
     is visible on the main screen, rather than buried in Settings. */
  function renderSyncBanner() {
    var banner = $('#syncBanner');
    var badge = $('#accountBadge');
    if (!banner) return;

    var signedIn = window.Sync && Sync.signedIn();

    banner.hidden = !!signedIn || !isToday();
    if (badge) badge.hidden = !!signedIn;

    if (!signedIn) {
      $('#syncBannerTitle').textContent = 'Back up your data';
      $('#syncBannerSub').textContent = window.Sync && Sync.configured()
        ? 'Sign in to sync across devices'
        : 'Connect a Supabase project to sync';
    }
  }

  /* Account button: straight to sign-in when signed out, status when in. */
  function openAccount() {
    if (!window.Sync || !Sync.configured()) { openConnectForm(); return; }
    if (!Sync.signedIn()) { openAuthForm('signin'); return; }

    UI.openSheet('Account', function (body, close) {
      body.appendChild(syncPanel(close));
    });
  }

  function renderTimerCard() {
    var running = S.state.running;
    var paused = S.isPaused();
    var card = $('#timerCard');
    var btnText = $('#btnPrimaryText');
    var label = $('#timerLabel');
    var ring = $('#ringFill');

    card.classList.toggle('is-running', !!running && !paused);
    card.classList.toggle('is-paused', paused);

    // Primary action is whatever moves the session forward: start it,
    // pause it, or pick it back up.
    btnText.textContent = !running ? 'Start tracking' : (paused ? 'Resume' : 'Pause');
    $('#timerSecondary').hidden = !running;

    if (running) {
      label.textContent = (paused ? 'Paused · ' : '') + S.runningLabel();
      var act = S.activityById(running.activityId);
      ring.style.stroke = act ? act.color : 'var(--accent)';
    } else {
      label.textContent = 'Nothing running';
      ring.style.stroke = 'var(--track)';
      ring.style.strokeDashoffset = 553;
    }
    tickTimer();
  }

  /* Called every second by app.js while a timer runs. */
  function tickTimer() {
    var running = S.state.running;
    var ms = running ? S.elapsed() : 0;
    $('#timerElapsed').textContent = UI.fmtClock(ms);

    // The ring completes one sweep per hour — a visual sense of pace.
    var ring = $('#ringFill');
    if (running) {
      var frac = (ms % 3600000) / 3600000;
      ring.style.strokeDashoffset = 553 * (1 - frac);
    }

    // live bar
    var bar = $('#liveBar');
    var paused = S.isPaused();
    bar.hidden = !running;
    bar.classList.toggle('is-paused', paused);
    document.body.classList.toggle('has-live', !!running);
    if (running) {
      $('#liveBarLabel').textContent = S.runningLabel();
      $('#liveBarTime').textContent = UI.fmtClock(ms);
      var act = S.activityById(running.activityId);
      $('#liveBarSub').textContent = paused
        ? 'Paused'
        : (act ? act.icon + '  ' + act.name : 'since ' + UI.fmtTime(S.sessionStart()));
      $('#liveBarPause').setAttribute('aria-label', paused ? 'Resume timer' : 'Pause timer');
      // Swap the glyph between pause bars and a play triangle.
      $('#liveBarPauseIcon').innerHTML = paused
        ? '<path d="M8 5.6v12.8a1 1 0 0 0 1.54.84l9.2-6.4a1 1 0 0 0 0-1.68l-9.2-6.4A1 1 0 0 0 8 5.6z" fill="currentColor"/>'
        : '<rect x="7" y="5.5" width="3.6" height="13" rx="1.3" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.3" fill="currentColor"/>';
    }
  }

  function renderQuickChips() {
    var wrap = $('#quickChips');
    clear(wrap);
    var running = S.state.running;

    S.state.activities.filter(function (a) { return !a.archived; }).forEach(function (a) {
      var isLive = running && running.activityId === a.id && !running.taskId && !running.habitId;
      wrap.appendChild(el('button', {
        class: 'chip' + (isLive ? ' is-on' : ''),
        onClick: function () {
          if (isLive) S.stop().then(function () { UI.toast('Stopped ' + a.name); });
          else S.start({ activityId: a.id }).then(function () { UI.toast('Tracking ' + a.name); });
        }
      }, [
        el('span', { class: 'chip-dot', style: 'background:' + a.color }),
        a.icon + ' ' + a.name
      ]));
    });

    wrap.appendChild(el('button', {
      class: 'chip', style: 'color:var(--text-mute)',
      onClick: openActivityForm
    }, ['+ New']));
  }

  function renderTodayTotals(day) {
    var total = S.totalForDay(day, true);
    $('#todayTotal').textContent = UI.fmtDuration(total);

    var stack = $('#todayStack');
    var legend = $('#todayLegend');
    clear(stack); clear(legend);

    // Scoped to the day, so a session running over midnight contributes
    // only its share to each side.
    var groups = S.byActivity(S.entriesForDay(day), true, day);

    if (!total) {
      stack.appendChild(el('div', { class: 'stackbar-empty' }));
      legend.appendChild(el('span', { class: 'legend-item', style: 'color:var(--text-mute)' },
        [isToday() ? 'Nothing tracked yet today.' : 'Nothing tracked on this day.']));
      return;
    }

    groups.forEach(function (g) {
      var pct = (g.ms / total) * 100;
      stack.appendChild(el('div', {
        class: 'stackbar-seg',
        style: 'width:' + pct + '%;background:' + g.activity.color,
        title: g.activity.name + ' — ' + UI.fmtDuration(g.ms)
      }));
      legend.appendChild(el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-dot', style: 'background:' + g.activity.color }),
        el('span', { class: 'legend-name', text: g.activity.name }),
        el('span', { class: 'legend-val', text: UI.fmtDuration(g.ms) })
      ]));
    });
  }

  function renderTimeline(day) {
    var wrap = $('#todayTimeline');
    clear(wrap);

    var entries = S.entriesForDay(day).slice().sort(function (a, b) { return b.start - a.start; });
    var running = S.state.running;
    // `running.start` is null while paused — the segment before the pause
    // is already a normal entry below, so there is no live row to draw.
    var liveOnThisDay = running && running.start &&
      S.sliceForDay({ start: running.start, end: Date.now() }, day) > 0;

    if (liveOnThisDay) {
      wrap.appendChild(timelineRow({
        id: '_live',
        activityId: running.activityId, taskId: running.taskId, habitId: running.habitId,
        note: running.note, start: running.start, end: Date.now()
      }, true, day));
    }

    if (!entries.length && !liveOnThisDay) {
      wrap.appendChild(el('p', { class: 'hint', text: isToday()
        ? 'No sessions logged today. Hit start above, or add one manually.'
        : 'Nothing logged on this day. You can still add an entry.' }));
      return;
    }

    entries.forEach(function (e) { wrap.appendChild(timelineRow(e, false, day)); });
  }

  function timelineRow(e, isLive, day) {
    var act = S.activityById(e.activityId);
    var color = act ? act.color : '#7b849b';

    var title = act ? act.name : 'Unsorted';
    var sub = '';
    if (e.taskId) { var t = S.taskById(e.taskId); if (t) { title = t.title; sub = act ? act.name : 'Task'; } }
    else if (e.habitId) { var h = S.habitById(e.habitId); if (h) { title = h.name; sub = 'Habit'; } }
    if (e.note) sub = sub ? sub + ' · ' + e.note : e.note;

    var meta = UI.fmtTime(e.start) + ' – ' + (isLive ? 'now' : UI.fmtTime(e.end));
    if (sub) meta += '  ·  ' + sub;

    // A session that ran over midnight appears on both days it touches.
    // Show its true start and end, but count only this day's share, and
    // say so — otherwise the row looks like it disagrees with the total.
    var crosses = !isLive && day && S.spansDays(e);
    var shown = (day && !isLive) ? S.sliceForDay(e, day) : (e.end - e.start);
    if (crosses) {
      meta = UI.fmtDayShortName(e.start) + ' ' + UI.fmtTime(e.start) +
             ' – ' + UI.fmtDayShortName(e.end) + ' ' + UI.fmtTime(e.end) +
             (sub ? '  ·  ' + sub : '');
    }

    var title_ = el('div', { class: 'tl-title' }, [
      el('span', { text: title }),
      crosses ? el('span', { class: 'tl-span', text: 'over midnight' }) : null
    ]);

    return el('div', {
      class: 'tl-item' + (isLive ? ' is-live' : ''),
      onClick: isLive ? null : function () { openEntryActions(e); }
    }, [
      el('div', { class: 'tl-rail', style: 'background:' + color }),
      el('div', { class: 'tl-body' }, [
        title_,
        el('div', { class: 'tl-meta', text: meta })
      ]),
      el('div', { class: 'tl-dur mono', text: UI.fmtDuration(shown) })
    ]);
  }

  /* ══════════════════════ TASKS ══════════════════════ */

  var taskFilter = 'open';

  function setTaskFilter(f) { taskFilter = f; renderTasks(); }

  function renderTasks() {
    var list = $('#taskList');
    clear(list);

    var today = S.todayKey();
    var tasks = S.state.tasks.slice();

    var shown = tasks.filter(function (t) {
      if (taskFilter === 'open')  return !t.done;
      if (taskFilter === 'done')  return !!t.done;
      if (taskFilter === 'today') return !t.done && t.dueDay === today;
      return true;
    });

    // Open tasks: newest first. Done: most recently completed first.
    shown.sort(function (a, b) {
      if (taskFilter === 'done') return (b.completedAt || 0) - (a.completedAt || 0);
      return b.createdAt - a.createdAt;
    });

    var openCount = tasks.filter(function (t) { return !t.done; }).length;
    var doneToday = tasks.filter(function (t) {
      return t.done && t.completedAt && S.dayKey(t.completedAt) === today;
    }).length;
    $('#tasksSummary').textContent = openCount + ' open · ' + doneToday + ' done today';

    $('#taskEmpty').hidden = shown.length > 0;
    shown.forEach(function (t) { list.appendChild(taskRow(t)); });
  }

  function taskRow(t) {
    var running = S.state.running;
    var isLive = running && running.taskId === t.id;
    var act = S.activityById(t.activityId);
    var spent = S.timeOnTask(t.id);

    var metaParts = [];
    if (act) metaParts.push(act.icon + ' ' + act.name);
    if (spent > 0) metaParts.push(UI.fmtDuration(spent));
    if (t.dueDay) {
      metaParts.push(t.dueDay === S.todayKey() ? 'Today'
        : t.dueDay < S.todayKey() ? 'Overdue' : UI.fmtDayLong(t.dueDay).split(',')[0]);
    }

    var check = el('button', {
      class: 'check' + (t.done ? ' is-on' : ''),
      'aria-label': t.done ? 'Mark not done' : 'Mark done',
      onClick: function (ev) {
        ev.stopPropagation();
        S.toggleTask(t.id).then(function () {
          if (!t.done) UI.toast('Nice — "' + t.title + '" done');
        });
      }
    });
    check.appendChild(checkSvg());

    var play = el('button', {
      class: 'play' + (isLive ? ' is-live' : ''),
      'aria-label': isLive ? 'Stop timer' : 'Start timer on this task',
      onClick: function (ev) {
        ev.stopPropagation();
        if (isLive) S.stop().then(function () { UI.toast('Stopped'); });
        else S.start({ taskId: t.id, activityId: t.activityId }).then(function () {
          UI.toast('Tracking "' + t.title + '"');
        });
      }
    });
    play.appendChild(playSvg(isLive));

    return el('div', {
      class: 'row' + (isLive ? ' is-live' : ''),
      onClick: function () { openTaskForm(t); }
    }, [
      check,
      el('div', { class: 'row-body' }, [
        el('div', { class: 'row-title' + (t.done ? ' is-done' : ''), text: t.title }),
        metaParts.length ? el('div', { class: 'row-meta', text: metaParts.join('  ·  ') }) : null
      ]),
      t.done ? null : play
    ]);
  }

  /* ══════════════════════ HABITS ══════════════════════ */

  function renderHabits() {
    var list = $('#habitList');
    clear(list);

    var today = S.todayKey();
    var habits = S.state.habits.filter(function (h) { return !h.archived; });

    var due = habits.filter(S.isScheduledToday);
    var doneCount = due.filter(function (h) { return S.isChecked(h.id, today); }).length;
    $('#habitsSummary').textContent = due.length
      ? doneCount + ' of ' + due.length + ' done today'
      : 'nothing scheduled today';

    $('#habitEmpty').hidden = habits.length > 0;

    // Scheduled-today habits float to the top.
    habits.sort(function (a, b) {
      var sa = S.isScheduledToday(a) ? 0 : 1, sb = S.isScheduledToday(b) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.createdAt - b.createdAt;
    });

    habits.forEach(function (h) { list.appendChild(habitRow(h)); });
  }

  function habitRow(h) {
    var today = S.todayKey();
    var checked = S.isChecked(h.id, today);
    var scheduled = S.isScheduledToday(h);
    var streak = S.habitStreak(h.id);
    var running = S.state.running;
    var isLive = running && running.habitId === h.id;

    var check = el('button', {
      class: 'check' + (checked ? ' is-on' : ''),
      'aria-label': checked ? 'Undo' : 'Mark done today',
      onClick: function (ev) {
        ev.stopPropagation();
        S.toggleCheck(h.id).then(function () {
          if (!checked) UI.toast(h.name + ' ✓  streak ' + S.habitStreak(h.id));
        });
      }
    });
    check.appendChild(checkSvg());

    /* last 7 days at a glance */
    var dots = el('div', { class: 'dots' });
    for (var i = 6; i >= 0; i--) {
      var day = S.addDays(today, -i);
      var d = new Date(day + 'T00:00:00');
      var isSched = h.days.indexOf(d.getDay()) !== -1;
      var on = S.isChecked(h.id, day);
      dots.appendChild(el('div', {
        class: 'dot' + (on ? ' is-on' : '') + (isSched ? '' : ' is-off'),
        style: on ? 'background:' + h.color : '',
        title: day
      }));
    }

    var children = [
      check,
      el('div', { class: 'row-body' }, [
        // Icon sits outside the strikethrough so completing a habit doesn't
        // draw a line through the emoji.
        el('div', { class: 'row-title' }, [
          el('span', { class: 'row-icon', text: h.icon }),
          el('span', { class: checked ? 'is-done' : '', text: h.name })
        ]),
        el('div', { class: 'row-meta' }, [
          streak > 0 ? el('span', { class: 'streak', text: '🔥 ' + streak }) : null,
          el('span', { text: scheduled ? 'scheduled today' : 'not today' })
        ]),
        dots
      ])
    ];

    /* Timed habits get a progress bar and their own play button. */
    if (h.type === 'timed' && h.targetMin) {
      var mins = S.habitMinutes(h.id, today);
      var pct = Math.min(100, (mins / h.targetMin) * 100);
      children[1].appendChild(el('div', { class: 'prog' }, [
        el('div', { class: 'prog-fill', style: 'width:' + pct + '%;background:' + h.color })
      ]));
      children[1].appendChild(el('div', {
        class: 'row-meta',
        style: 'margin-top:5px',
        text: mins + ' / ' + h.targetMin + ' min today'
      }));

      var play = el('button', {
        class: 'play' + (isLive ? ' is-live' : ''),
        'aria-label': isLive ? 'Stop' : 'Start timing this habit',
        onClick: function (ev) {
          ev.stopPropagation();
          if (isLive) S.stop().then(function () { UI.toast('Stopped'); });
          else S.start({ habitId: h.id, activityId: h.activityId }).then(function () {
            UI.toast('Tracking ' + h.name);
          });
        }
      });
      play.appendChild(playSvg(isLive));
      children.push(play);
    }

    return el('div', {
      class: 'row is-stacked' + (isLive ? ' is-live' : ''),
      onClick: function () { openHabitForm(h); }
    }, children);
  }

  /* ══════════════════════ INSIGHTS ══════════════════════ */

  var statsRange = 7;

  function setStatsRange(n) { statsRange = n; renderStats(); }

  function renderStats() {
    var series = S.dailySeries(statsRange);
    var from = series[0].day, to = series[series.length - 1].day;

    $('#statsRangeLabel').textContent = 'Last ' + statsRange + ' days';

    var total = series.reduce(function (n, d) { return n + d.ms; }, 0);
    var daysWithData = series.filter(function (d) { return d.ms > 0; }).length || 1;

    $('#kpiTotal').textContent  = UI.fmtShort(total);
    $('#kpiAvg').textContent    = UI.fmtShort(total / daysWithData);
    $('#kpiStreak').textContent = S.trackingStreak();

    renderBarChart(series);
    renderBreakdown(from, to, total);
    renderHeatmap(from, to);
  }

  function renderBarChart(series) {
    var wrap = $('#barChart');
    clear(wrap);
    var max = Math.max.apply(null, series.map(function (d) { return d.ms; })) || 1;
    var today = S.todayKey();

    // Beyond ~14 bars, labels would collide — show only a few.
    var labelEvery = series.length > 14 ? Math.ceil(series.length / 7) : 1;

    series.forEach(function (d, i) {
      var pct = (d.ms / max) * 100;
      wrap.appendChild(el('div', { class: 'bar-col' }, [
        el('div', {
          class: 'bar' + (d.day === today ? ' is-today' : ''),
          style: 'height:' + Math.max(2, pct) + '%',
          title: d.day + ' — ' + UI.fmtDuration(d.ms)
        }),
        el('div', {
          class: 'bar-label',
          text: (i % labelEvery === 0) ? UI.fmtDayShort(d.day) : ''
        })
      ]));
    });
  }

  function renderBreakdown(from, to, total) {
    var wrap = $('#breakdown');
    clear(wrap);

    // Scoped to the range, so a session hanging over either edge isn't
    // counted in full here while the KPI above counts only its share.
    var groups = S.byActivity(S.entriesInRange(from, to), true, from, to);
    if (!groups.length) {
      wrap.appendChild(el('p', { class: 'hint', text: 'No time tracked in this range yet.' }));
      return;
    }

    var max = groups[0].ms || 1;
    groups.forEach(function (g) {
      var pctOfTotal = total ? Math.round((g.ms / total) * 100) : 0;
      wrap.appendChild(el('div', { class: 'bd-item' }, [
        el('div', { class: 'bd-head' }, [
          el('span', { class: 'bd-name' }, [
            el('span', { class: 'legend-dot', style: 'background:' + g.activity.color }),
            g.activity.icon + ' ' + g.activity.name
          ]),
          el('span', { class: 'bd-val', text: UI.fmtDuration(g.ms) + '  ·  ' + pctOfTotal + '%' })
        ]),
        el('div', { class: 'bd-track' }, [
          el('div', { class: 'bd-fill', style: 'width:' + ((g.ms / max) * 100) + '%;background:' + g.activity.color })
        ])
      ]));
    });
  }

  function renderHeatmap(from, to) {
    var wrap = $('#heatmap');
    clear(wrap);
    var buckets = S.hourHistogram(from, to);
    var max = Math.max.apply(null, buckets) || 1;

    // This grid shows density, not a category, so it stays monochrome —
    // saturated colour in the app means "this is an activity".
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    var base = light ? '9,9,11' : '244,244,245';

    buckets.forEach(function (ms, hour) {
      var intensity = ms / max;
      var style = '';
      if (intensity > 0) {
        style = 'background:rgba(' + base + ',' + (0.1 + intensity * 0.8).toFixed(3) + ')';
        // Flip the label once the cell is dark/light enough to swallow it.
        if (intensity > 0.55) style += ';color:' + (light ? '#fff' : '#000');
      }
      wrap.appendChild(el('div', {
        class: 'hm-cell',
        style: style,
        title: hour + ':00 — ' + UI.fmtDuration(ms),
        text: hour % 3 === 0 ? String(hour) : ''
      }));
    });
  }

  /* ══════════════════════ SHEETS / FORMS ══════════════════════ */

  /* ── pick what to track ───────────────────────────────────── */
  function openStartPicker() {
    UI.openSheet('Start tracking', function (body, close) {
      var list = el('div', { class: 'picklist' });

      S.state.activities.filter(function (a) { return !a.archived; }).forEach(function (a) {
        list.appendChild(el('button', {
          class: 'pick',
          onClick: function () {
            close();
            S.start({ activityId: a.id }).then(function () { UI.toast('Tracking ' + a.name); });
          }
        }, [
          el('span', { class: 'pick-icon', style: 'background:' + UI.hexToRgba(a.color, .16), text: a.icon }),
          el('span', { class: 'pick-name', text: a.name })
        ]));
      });

      var openTasks = S.state.tasks.filter(function (t) { return !t.done; }).slice(0, 8);
      if (openTasks.length) {
        body.appendChild(el('p', { class: 'label', text: 'Activities' }));
        body.appendChild(list);
        body.appendChild(el('p', { class: 'label', style: 'margin-top:18px', text: 'Open tasks' }));
        var tl = el('div', { class: 'picklist' });
        openTasks.forEach(function (t) {
          var a = S.activityById(t.activityId);
          tl.appendChild(el('button', {
            class: 'pick',
            onClick: function () {
              close();
              S.start({ taskId: t.id, activityId: t.activityId }).then(function () {
                UI.toast('Tracking "' + t.title + '"');
              });
            }
          }, [
            el('span', { class: 'pick-icon', style: 'background:' + UI.hexToRgba(a ? a.color : '#7b849b', .16), text: '✓' }),
            el('span', {}, [
              el('div', { class: 'pick-name', text: t.title }),
              a ? el('div', { class: 'pick-sub', text: a.name }) : null
            ])
          ]));
        });
        body.appendChild(tl);
      } else {
        body.appendChild(list);
      }
    });
  }

  /* ── activity form ────────────────────────────────────────── */
  function openActivityForm(activity) {
    var editing = !!activity;
    var color = editing ? activity.color : S.PALETTE[S.state.activities.length % S.PALETTE.length];
    var icon = editing ? activity.icon : '🎯';

    UI.openSheet(editing ? 'Edit activity' : 'New activity', function (body, close) {
      var name = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Deep work', value: editing ? activity.name : '' });

      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Name' }), name]));

      /* icon picker */
      var iconWrap = el('div', { class: 'swatches' });
      ICONS.forEach(function (ic) {
        var b = el('button', {
          class: 'swatch' + (ic === icon ? ' is-on' : ''),
          style: 'background:var(--surface-2);font-size:17px',
          text: ic,
          onClick: function () {
            icon = ic;
            UI.$$('.swatch', iconWrap).forEach(function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
          }
        });
        iconWrap.appendChild(b);
      });
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Icon' }), iconWrap]));

      /* colour picker */
      var colorWrap = el('div', { class: 'swatches' });
      S.PALETTE.forEach(function (c) {
        var b = el('button', {
          class: 'swatch' + (c === color ? ' is-on' : ''),
          style: 'background:' + c,
          onClick: function () {
            color = c;
            UI.$$('.swatch', colorWrap).forEach(function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
          }
        });
        colorWrap.appendChild(b);
      });
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Colour' }), colorWrap]));

      var actions = el('div', { class: 'sheet-actions' }, [
        editing ? el('button', {
          class: 'btn btn-danger', text: 'Delete',
          onClick: function () {
            close();
            UI.confirmSheet('Delete activity?',
              'Past entries keep their time but lose this label.', 'Delete',
              function () { S.deleteActivity(activity.id).then(function () { UI.toast('Deleted'); }); });
          }
        }) : null,
        el('button', {
          class: 'btn btn-primary', text: editing ? 'Save' : 'Create',
          onClick: function () {
            var v = name.value.trim();
            if (!v) { name.focus(); return; }
            S.saveActivity({ id: editing ? activity.id : null, name: v, color: color, icon: icon })
              .then(function () { close(); UI.toast(editing ? 'Saved' : 'Activity created'); });
          }
        })
      ]);
      body.appendChild(actions);

      name.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); actions.lastChild.click(); }
      });
    });
  }

  function openActivityManager() {
    UI.openSheet('Activities', function (body, close) {
      var list = el('div', { class: 'picklist' });
      S.state.activities.forEach(function (a) {
        list.appendChild(el('button', {
          class: 'pick',
          onClick: function () { close(); openActivityForm(a); }
        }, [
          el('span', { class: 'pick-icon', style: 'background:' + UI.hexToRgba(a.color, .16), text: a.icon }),
          el('span', { class: 'pick-name', text: a.name })
        ]));
      });
      body.appendChild(list);
      body.appendChild(el('div', { class: 'sheet-actions' }, [
        el('button', {
          class: 'btn btn-primary', text: '+ New activity',
          onClick: function () { close(); openActivityForm(null); }
        })
      ]));
    });
  }

  /* ── task form ────────────────────────────────────────────── */
  function openTaskForm(task) {
    var editing = !!task;

    UI.openSheet(editing ? 'Task' : 'New task', function (body, close) {
      var title = el('input', { class: 'input', type: 'text', placeholder: 'What needs doing?', value: editing ? task.title : '' });
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Title' }), title]));

      var actSel = el('select', { class: 'select' });
      actSel.appendChild(el('option', { value: '', text: 'No activity' }));
      S.state.activities.forEach(function (a) {
        var o = el('option', { value: a.id, text: a.icon + '  ' + a.name });
        if (editing && task.activityId === a.id) o.selected = true;
        actSel.appendChild(o);
      });

      var due = el('input', { class: 'input', type: 'date', value: editing && task.dueDay ? task.dueDay : '' });

      body.appendChild(el('div', { class: 'row-2' }, [
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Activity' }), actSel]),
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Due' }), due])
      ]));

      var notes = el('textarea', { class: 'textarea', placeholder: 'Notes (optional)' });
      notes.value = editing ? (task.notes || '') : '';
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Notes' }), notes]));

      if (editing) {
        var spent = S.timeOnTask(task.id);
        body.appendChild(el('p', { class: 'hint', text: spent ? 'Time logged: ' + UI.fmtDuration(spent) : 'No time logged on this task yet.' }));
      }

      var save = el('button', {
        class: 'btn btn-primary', text: editing ? 'Save' : 'Add task',
        onClick: function () {
          var v = title.value.trim();
          if (!v) { title.focus(); return; }
          S.saveTask({
            id: editing ? task.id : null,
            title: v,
            activityId: actSel.value || null,
            dueDay: due.value || null,
            notes: notes.value.trim()
          }).then(function () { close(); UI.toast(editing ? 'Saved' : 'Task added'); });
        }
      });

      body.appendChild(el('div', { class: 'sheet-actions' }, [
        editing ? el('button', {
          class: 'btn btn-danger', text: 'Delete',
          onClick: function () {
            close();
            UI.confirmSheet('Delete task?', 'Logged time stays in your history.', 'Delete',
              function () { S.deleteTask(task.id).then(function () { UI.toast('Deleted'); }); });
          }
        }) : null,
        save
      ]));

      title.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); save.click(); }
      });
    });
  }

  /* ── habit form ───────────────────────────────────────────── */
  function openHabitForm(habit) {
    var editing = !!habit;
    var color = editing ? habit.color : S.PALETTE[S.state.habits.length % S.PALETTE.length];
    var icon = editing ? habit.icon : '◎';
    var days = editing ? habit.days.slice() : [0, 1, 2, 3, 4, 5, 6];

    UI.openSheet(editing ? 'Habit' : 'New habit', function (body, close) {
      var name = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Read', value: editing ? habit.name : '' });
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Name' }), name]));

      /* type: simple check vs timed */
      var typeTimed = editing ? habit.type === 'timed' : false;
      var segType = el('div', { class: 'seg', style: 'margin-bottom:15px' });
      var bCheck = el('button', { class: 'seg-btn' + (typeTimed ? '' : ' is-on'), text: 'Just check it' });
      var bTimed = el('button', { class: 'seg-btn' + (typeTimed ? ' is-on' : ''), text: 'Timed' });
      var timedFields = el('div', { style: typeTimed ? '' : 'display:none' });

      bCheck.addEventListener('click', function () {
        typeTimed = false;
        bCheck.classList.add('is-on'); bTimed.classList.remove('is-on');
        timedFields.style.display = 'none';
      });
      bTimed.addEventListener('click', function () {
        typeTimed = true;
        bTimed.classList.add('is-on'); bCheck.classList.remove('is-on');
        timedFields.style.display = '';
      });
      segType.appendChild(bCheck); segType.appendChild(bTimed);
      body.appendChild(el('label', { class: 'label', text: 'Type' }));
      body.appendChild(segType);

      var target = el('input', {
        class: 'input', type: 'number', min: '1', placeholder: '30',
        value: editing && habit.targetMin ? habit.targetMin : '30'
      });
      timedFields.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'label', text: 'Daily target (minutes)' }), target
      ]));
      timedFields.appendChild(el('p', { class: 'hint', text: 'Once you log this much in a day, the habit ticks itself off.' }));
      body.appendChild(timedFields);

      /* which days */
      var dayWrap = el('div', { class: 'daypick' });
      DAY_LABELS.forEach(function (lab, idx) {
        var b = el('button', {
          class: 'daypick-btn' + (days.indexOf(idx) !== -1 ? ' is-on' : ''),
          text: lab,
          onClick: function () {
            var at = days.indexOf(idx);
            if (at === -1) { days.push(idx); b.classList.add('is-on'); }
            else { days.splice(at, 1); b.classList.remove('is-on'); }
          }
        });
        dayWrap.appendChild(b);
      });
      body.appendChild(el('div', { class: 'field', style: 'margin-top:15px' }, [
        el('label', { class: 'label', text: 'Days' }), dayWrap
      ]));

      /* icon + colour */
      var iconWrap = el('div', { class: 'swatches' });
      ICONS.forEach(function (ic) {
        var b = el('button', {
          class: 'swatch' + (ic === icon ? ' is-on' : ''),
          style: 'background:var(--surface-2);font-size:17px', text: ic,
          onClick: function () {
            icon = ic;
            UI.$$('.swatch', iconWrap).forEach(function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
          }
        });
        iconWrap.appendChild(b);
      });
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Icon' }), iconWrap]));

      var colorWrap = el('div', { class: 'swatches' });
      S.PALETTE.forEach(function (c) {
        var b = el('button', {
          class: 'swatch' + (c === color ? ' is-on' : ''), style: 'background:' + c,
          onClick: function () {
            color = c;
            UI.$$('.swatch', colorWrap).forEach(function (x) { x.classList.remove('is-on'); });
            b.classList.add('is-on');
          }
        });
        colorWrap.appendChild(b);
      });
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Colour' }), colorWrap]));

      var save = el('button', {
        class: 'btn btn-primary', text: editing ? 'Save' : 'Create habit',
        onClick: function () {
          var v = name.value.trim();
          if (!v) { name.focus(); return; }
          if (!days.length) { UI.toast('Pick at least one day'); return; }
          S.saveHabit({
            id: editing ? habit.id : null,
            name: v, color: color, icon: icon,
            type: typeTimed ? 'timed' : 'check',
            targetMin: typeTimed ? Math.max(1, parseInt(target.value, 10) || 30) : 0,
            days: days.slice().sort()
          }).then(function () { close(); UI.toast(editing ? 'Saved' : 'Habit created'); });
        }
      });

      body.appendChild(el('div', { class: 'sheet-actions' }, [
        editing ? el('button', {
          class: 'btn btn-danger', text: 'Delete',
          onClick: function () {
            close();
            UI.confirmSheet('Delete habit?', 'Its check history will be removed too.', 'Delete',
              function () { S.deleteHabit(habit.id).then(function () { UI.toast('Deleted'); }); });
          }
        }) : null,
        save
      ]));
    });
  }

  /* ── add / edit an entry ──────────────────────────────────── */
  /* One form for both. Passing an entry edits it; passing nothing
     creates one, defaulting to the last hour. */
  function openEntryForm(entry) {
    var editing = !!entry;

    UI.openSheet(editing ? 'Edit entry' : 'Add entry', function (body, close) {
      var now = Date.now();
      var startIn = el('input', {
        class: 'input', type: 'datetime-local',
        value: UI.toLocalInput(editing ? entry.start : now - 3600000)
      });
      var endIn = el('input', {
        class: 'input', type: 'datetime-local',
        value: UI.toLocalInput(editing ? entry.end : now)
      });

      var actSel = el('select', { class: 'select' });
      S.state.activities.forEach(function (a) {
        var o = el('option', { value: a.id, text: a.icon + '  ' + a.name });
        if (editing && entry.activityId === a.id) o.selected = true;
        actSel.appendChild(o);
      });

      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Activity' }), actSel]));
      body.appendChild(el('div', { class: 'row-2' }, [
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'From' }), startIn]),
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'To' }), endIn])
      ]));

      var note = el('input', { class: 'input', type: 'text', placeholder: 'Optional note' });
      note.value = editing ? (entry.note || '') : '';
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Note' }), note]));

      /* Live duration readout, so you can see what you're about to save. */
      var dur = el('p', { class: 'hint', style: 'margin:-6px 0 0' });
      var err = el('p', { class: 'hint', style: 'color:var(--bad);display:none' });
      body.appendChild(dur);
      body.appendChild(err);

      function times() {
        return [new Date(startIn.value).getTime(), new Date(endIn.value).getTime()];
      }

      function refresh() {
        var t = times();
        err.style.display = 'none';
        if (isNaN(t[0]) || isNaN(t[1]) || t[1] <= t[0]) { dur.textContent = ''; return; }
        dur.textContent = 'Duration: ' + UI.fmtDuration(t[1] - t[0]);
      }
      startIn.addEventListener('change', refresh);
      endIn.addEventListener('change', refresh);
      refresh();

      function fail(msg) { err.textContent = msg; err.style.display = ''; }

      var save = el('button', {
        class: 'btn btn-primary', text: editing ? 'Save' : 'Add',
        onClick: function () {
          var t = times();
          if (isNaN(t[0]) || isNaN(t[1])) { fail('Pick both a start and an end time.'); return; }
          if (t[1] <= t[0]) { fail('The end has to come after the start.'); return; }
          if (t[0] > Date.now()) { fail('That start time is in the future.'); return; }

          // One timer at a time is the whole premise, so an overlap means
          // one of the two entries is wrong. Better to say so than to
          // quietly let a day add up to more than 24 hours.
          var clash = S.findOverlap(t[0], t[1], editing ? entry.id : null);
          if (clash) {
            var ca = S.activityById(clash.activityId);
            fail('Overlaps ' + (ca ? ca.name : 'another entry') + ', ' +
                 UI.fmtTime(clash.start) + '–' + UI.fmtTime(clash.end) +
                 '. Edit that one first.');
            return;
          }

          var data = {
            activityId: actSel.value || null,
            start: t[0], end: t[1],
            note: note.value.trim()
          };

          var action = editing
            ? S.updateEntry(entry.id, data)
            : S.addManualEntry(data);

          action.then(function () {
            close();
            UI.toast(editing ? 'Entry updated' : 'Entry added');
          }).catch(function (e2) { fail(e2.message || 'Could not save that.'); });
        }
      });

      body.appendChild(el('div', { class: 'sheet-actions' }, [
        editing ? el('button', {
          class: 'btn btn-danger', text: 'Delete',
          onClick: function () {
            close();
            UI.confirmSheet('Delete this entry?',
              'The time it recorded is removed from your totals.', 'Delete',
              function () { S.deleteEntry(entry.id).then(function () { UI.toast('Entry deleted'); }); });
          }
        }) : el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: close }),
        save
      ]));
    });
  }

  /* Tapping a timeline row goes straight to editing it. */
  function openEntryActions(entry) {
    openEntryForm(entry);
  }

  /* ── runaway timer ────────────────────────────────────────── */

  var RUNAWAY_KEY = 'chrona:runawayHours';
  var RUNAWAY_DEFAULT = 8;

  function runawayHours() {
    try {
      var v = localStorage.getItem(RUNAWAY_KEY);
      if (v === null) return RUNAWAY_DEFAULT;
      return parseInt(v, 10) || 0;      // 0 means off
    } catch (e) { return RUNAWAY_DEFAULT; }
  }

  function setRunawayHours(h) {
    try { localStorage.setItem(RUNAWAY_KEY, String(h)); } catch (e) {}
  }

  /* Has the running timer been going long enough to be suspicious? */
  function runawayPending() {
    var r = S.state.running;
    if (!r || r.warned) return false;
    // A paused session isn't running away — nothing is accruing.
    if (r.paused) return false;
    var limit = runawayHours();
    if (!limit) return false;
    return S.elapsed() > limit * 3600000;
  }

  var runawayOpen = false;

  /* Returns true when it opened the prompt, so callers can skip whatever
     else they were about to show. */
  function checkRunaway() {
    if (runawayOpen || UI.sheetOpen() || !runawayPending()) return false;
    runawayOpen = true;
    openRunawaySheet();
    return true;
  }

  function openRunawaySheet() {
    var r = S.state.running;
    var label = S.runningLabel();
    var ran = S.elapsed();
    // lastSeen is only advanced while the app is on screen, so it marks
    // when you were genuinely last here.
    var seen = r.lastSeen || r.start;
    var trimmed = Math.max(0, seen - r.start);
    var canTrim = trimmed > 60000 && seen < Date.now() - 60000;

    UI.openSheet('Still running?', function (body, close) {
      body.appendChild(el('p', {
        class: 'hint', style: 'font-size:14px;color:var(--text-dim);margin:0 0 4px',
        text: '"' + label + '" has been running for ' + UI.fmtDuration(ran) +
              ', since ' + UI.fmtTime(S.sessionStart()) + '.'
      }));
      body.appendChild(el('p', {
        class: 'hint', style: 'margin:0 0 16px',
        text: canTrim
          ? 'You last had the app open at ' + UI.fmtTime(seen) +
            '. If you forgot to stop it, you can end it there instead.'
          : 'If that is right, keep it. Otherwise you can correct or discard it.'
      }));

      var actions = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });

      actions.appendChild(el('button', {
        class: 'btn btn-primary', text: 'Keep it — still going',
        onClick: function () { S.markWarned(); close(); }
      }));

      if (canTrim) {
        actions.appendChild(el('button', {
          class: 'btn btn-ghost',
          text: 'Stop at ' + UI.fmtTime(seen) + '  (' + UI.fmtDuration(trimmed) + ')',
          onClick: function () {
            close();
            S.stopAt(seen).then(function (entry) {
              UI.toast(entry ? 'Logged ' + UI.fmtDuration(entry.end - entry.start) : 'Too short — discarded');
            });
          }
        }));
      }

      actions.appendChild(el('button', {
        class: 'btn btn-ghost', text: 'Stop now and edit the times',
        onClick: function () {
          close();
          S.stop().then(function (entry) {
            if (entry) openEntryForm(entry);
            else UI.toast('Too short — discarded');
          });
        }
      }));

      actions.appendChild(el('button', {
        class: 'btn btn-danger', text: 'Discard it',
        onClick: function () {
          close();
          UI.confirmSheet('Discard this session?',
            UI.fmtDuration(ran) + ' will not be logged at all.', 'Discard',
            function () { S.discardRunning().then(function () { UI.toast('Discarded'); }); });
        }
      }));

      body.appendChild(actions);
    }, function () { runawayOpen = false; });
  }

  /* ── settings ─────────────────────────────────────────────── */
  function openSettings() {
    UI.openSheet('Settings', function (body, close) {
      /* theme */
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      var seg = el('div', { class: 'seg' });
      [['dark', 'Dark'], ['light', 'Light']].forEach(function (pair) {
        seg.appendChild(el('button', {
          class: 'seg-btn' + (current === pair[0] ? ' is-on' : ''),
          text: pair[1],
          onClick: function (ev) {
            document.documentElement.setAttribute('data-theme', pair[0]);
            try { localStorage.setItem('chrona:theme', pair[0]); } catch (e) {}
            UI.$$('.seg-btn', seg).forEach(function (b) { b.classList.remove('is-on'); });
            ev.currentTarget.classList.add('is-on');
          }
        }));
      });
      body.appendChild(el('label', { class: 'label', text: 'Theme' }));
      body.appendChild(seg);

      /* ── sound ── */
      body.appendChild(el('label', { class: 'label', style: 'margin-top:8px', text: 'Sound' }));

      var toggle = el('button', {
        class: 'switch' + (Sound.isOn() ? ' is-on' : ''),
        'aria-label': 'Toggle sounds'
      }, [el('span', { class: 'switch-knob' })]);

      var volField = el('div', { class: 'field', style: Sound.isOn() ? '' : 'display:none' });
      var vol = el('input', {
        class: 'range', type: 'range', min: '0', max: '100', step: '5',
        value: String(Math.round(Sound.getVolume() * 100))
      });
      // Preview at the new level as they drag, but not on every single step.
      var lastPreview = 0;
      vol.addEventListener('input', function () {
        Sound.setVolume(parseInt(vol.value, 10) / 100);
        var now = Date.now();
        if (now - lastPreview > 260) { lastPreview = now; Sound.play('switch'); }
      });
      volField.appendChild(el('label', { class: 'label', text: 'Volume' }));
      volField.appendChild(vol);

      toggle.addEventListener('click', function () {
        var on = !Sound.isOn();
        Sound.setEnabled(on);
        toggle.classList.toggle('is-on', on);
        volField.style.display = on ? '' : 'none';
      });

      body.appendChild(el('div', { class: 'setting-row' }, [
        el('div', {}, [
          el('div', { class: 'setting-name', text: 'Play sounds' }),
          el('div', { class: 'setting-sub', text: 'Cues when you start, stop and finish things' })
        ]),
        toggle
      ]));
      body.appendChild(volField);

      body.appendChild(el('div', { class: 'chip-row', style: 'margin-bottom:4px' },
        [['start', 'Start'], ['stop', 'Stop'], ['done', 'Done'], ['goal', 'Goal hit']].map(function (p) {
          return el('button', {
            class: 'chip', text: '▶ ' + p[1],
            onClick: function () {
              if (!Sound.isOn()) { UI.toast('Turn sounds on first'); return; }
              Sound.play(p[0]);
            }
          });
        })
      ));

      /* ── runaway timer ── */
      body.appendChild(el('label', { class: 'label', style: 'margin-top:14px', text: 'Forgotten timer' }));

      var runSeg = el('div', { class: 'seg' });
      [[0, 'Off'], [4, '4h'], [8, '8h'], [12, '12h']].forEach(function (pair) {
        runSeg.appendChild(el('button', {
          class: 'seg-btn' + (runawayHours() === pair[0] ? ' is-on' : ''),
          text: pair[1],
          onClick: function (ev) {
            setRunawayHours(pair[0]);
            UI.$$('.seg-btn', runSeg).forEach(function (b) { b.classList.remove('is-on'); });
            ev.currentTarget.classList.add('is-on');
          }
        }));
      });
      body.appendChild(runSeg);
      body.appendChild(el('p', { class: 'hint', style: 'margin:-8px 0 4px', text:
        'Ask about a timer that has run this long, in case you forgot to stop it. ' +
        'Turn it off if you deliberately track long sessions like sleep.' }));

      /* ── account / cloud sync ── */
      body.appendChild(el('label', { class: 'label', style: 'margin-top:14px', text: 'Cloud sync' }));
      body.appendChild(syncPanel(close));

      body.appendChild(el('label', { class: 'label', style: 'margin-top:14px', text: 'Your data' }));
      // Don't claim nothing leaves the device once sync is actually on.
      body.appendChild(el('p', { class: 'hint', style: 'margin:0 0 12px', text:
        Sync.signedIn()
          ? 'Stored on this device and backed up to your Supabase project. An export is still the easiest way to keep a copy you control.'
          : 'Everything lives on this device — nothing is uploaded anywhere. Export regularly if it matters to you.' }));

      body.appendChild(el('div', { class: 'sheet-actions', style: 'margin-top:0' }, [
        el('button', { class: 'btn btn-ghost', text: 'Export', onClick: exportData }),
        el('button', { class: 'btn btn-ghost', text: 'Import', onClick: importData })
      ]));

      body.appendChild(el('div', { class: 'sheet-actions' }, [
        el('button', {
          class: 'btn btn-danger', text: 'Erase everything',
          onClick: function () {
            close();
            UI.confirmSheet('Erase all data?',
              'Every entry, task and habit is permanently deleted. This cannot be undone.',
              'Erase everything',
              function () {
                DB.wipe().then(function () { location.reload(); });
              });
          }
        })
      ]));

      if (DB.usingFallback()) {
        body.appendChild(el('p', { class: 'hint', style: 'margin-top:16px;color:var(--warn)', text:
          'Heads up: IndexedDB is not available here, so data is stored in localStorage instead. ' +
          'Run the app from a local server (node server.js) for full database support.' }));
      }
    });
  }

  /* ── cloud sync panel ─────────────────────────────────────── */

  var STATUS_TEXT = {
    off:     ['Not connected',   'var(--text-mute)'],
    ready:   ['Connected',       'var(--text-dim)'],
    syncing: ['Syncing…',        'var(--accent)'],
    ok:      ['Synced',          'var(--good)'],
    error:   ['Sync problem',    'var(--bad)'],
    offline: ['Offline',         'var(--warn)']
  };

  function syncPanel(closeSheetFn) {
    var wrap = el('div');

    function paint() {
      clear(wrap);

      // Not configured yet: offer the connect form.
      if (!Sync.configured()) {
        wrap.appendChild(el('p', { class: 'hint', style: 'margin:0 0 10px', text:
          'Back your data up and use it on more than one device. Needs a free Supabase project — run supabase/schema.sql in it first.' }));
        wrap.appendChild(el('button', {
          class: 'btn btn-primary', style: 'width:100%',
          text: 'Connect Supabase',
          onClick: function () { closeSheetFn(); openConnectForm(); }
        }));
        return;
      }

      var st = STATUS_TEXT[Sync.state.status] || STATUS_TEXT.ready;

      // Configured but signed out.
      if (!Sync.signedIn()) {
        wrap.appendChild(el('div', { class: 'setting-row' }, [
          el('div', {}, [
            el('div', { class: 'setting-name', text: 'Not signed in' }),
            el('div', { class: 'setting-sub', text: 'Sign in to back up and sync.' })
          ])
        ]));
        wrap.appendChild(el('div', { class: 'sheet-actions', style: 'margin-top:0' }, [
          el('button', {
            class: 'btn btn-ghost', text: 'Sign up',
            onClick: function () { closeSheetFn(); openAuthForm('signup'); }
          }),
          el('button', {
            class: 'btn btn-primary', text: 'Sign in',
            onClick: function () { closeSheetFn(); openAuthForm('signin'); }
          })
        ]));
        return;
      }

      // Signed in.
      var last = Sync.state.lastSync
        ? 'Last synced ' + relativeTime(Sync.state.lastSync)
        : 'Not synced yet';

      wrap.appendChild(el('div', { class: 'setting-row' }, [
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'setting-name', text: Sync.userEmail() || 'Signed in' }),
          el('div', { class: 'setting-sub' }, [
            el('span', { style: 'color:' + st[1] + ';font-weight:600', text: st[0] }),
            el('span', { text: '  ·  ' + last })
          ])
        ]),
        el('button', {
          class: 'icon-btn', 'aria-label': 'Sync now',
          onClick: function (ev) {
            var btn = ev.currentTarget;
            btn.style.opacity = '.5';
            Sync.syncNow()
              .then(function (r) { UI.toast(r ? Sync.state.message : 'Nothing to sync'); })
              .catch(function (e) { UI.toast(e.message || 'Sync failed'); })
              .then(function () { btn.style.opacity = ''; paint(); });
          }
        }, [refreshSvg()])
      ]));

      if (Sync.state.message && Sync.state.status === 'error') {
        wrap.appendChild(el('p', { class: 'hint', style: 'color:var(--bad);margin:-4px 0 10px',
          text: Sync.state.message }));
      }

      var autoToggle = el('button', {
        class: 'switch' + (Sync.state.autoSync ? ' is-on' : ''),
        'aria-label': 'Toggle automatic sync'
      }, [el('span', { class: 'switch-knob' })]);
      autoToggle.addEventListener('click', function () {
        var on = !Sync.state.autoSync;
        Sync.setAutoSync(on);
        autoToggle.classList.toggle('is-on', on);
      });

      wrap.appendChild(el('div', { class: 'setting-row' }, [
        el('div', {}, [
          el('div', { class: 'setting-name', text: 'Sync automatically' }),
          el('div', { class: 'setting-sub', text: 'In the background as you make changes' })
        ]),
        autoToggle
      ]));

      wrap.appendChild(el('div', { class: 'sheet-actions', style: 'margin-top:0' }, [
        el('button', {
          class: 'btn btn-ghost', text: 'Sign out',
          onClick: function () {
            Sync.signOut().then(function () { UI.toast('Signed out'); paint(); });
          }
        }),
        el('button', {
          class: 'btn btn-ghost', text: 'Re-download all',
          onClick: function () {
            UI.toast('Pulling everything…');
            Sync.pullAll()
              .then(function () { UI.toast('Done — ' + Sync.state.message); paint(); })
              .catch(function (e) { UI.toast(e.message || 'Failed'); paint(); });
          }
        })
      ]));
    }

    paint();
    return wrap;
  }

  function refreshSvg() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '19'); s.setAttribute('height', '19');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M20 11A8 8 0 0 0 6.3 6.3L3 9M4 13a8 8 0 0 0 13.7 4.7L21 15M3 4v5h5M21 20v-5h-5');
    s.appendChild(p);
    return s;
  }

  function relativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  /* ── connect form ─────────────────────────────────────────── */
  function openConnectForm() {
    UI.openSheet('Connect Supabase', function (body, close) {
      body.appendChild(el('p', { class: 'hint', style: 'margin:0 0 14px', text:
        'In your Supabase dashboard: Project Settings → API. Copy the two values below. ' +
        'The anon key is designed to be public — row-level security is what protects your data.' }));

      var url = el('input', {
        class: 'input', type: 'url', placeholder: 'https://abcdefgh.supabase.co',
        value: Sync.state.url || ''
      });
      var key = el('textarea', {
        class: 'textarea', placeholder: 'anon public key', style: 'min-height:76px;font-size:12px'
      });
      key.value = Sync.state.anonKey || '';

      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Project URL' }), url]));
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Anon public key' }), key]));

      var err = el('p', { class: 'hint', style: 'color:var(--bad);display:none' });
      body.appendChild(err);

      body.appendChild(el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: close }),
        el('button', {
          class: 'btn btn-primary', text: 'Connect',
          onClick: function () {
            Sync.setConfig(url.value, key.value)
              .then(function () {
                close();
                UI.toast('Connected — now sign in');
                openAuthForm('signup');
              })
              .catch(function (e) {
                err.textContent = e.message;
                err.style.display = '';
              });
          }
        })
      ]));

      body.appendChild(el('p', { class: 'hint', style: 'margin-top:14px', text:
        'Haven\'t set the tables up yet? Run supabase/schema.sql from this project in the Supabase SQL editor first.' }));
    });
  }

  /* ── sign in / sign up ────────────────────────────────────── */
  function openAuthForm(mode) {
    var isSignUp = mode === 'signup';

    UI.openSheet(isSignUp ? 'Create account' : 'Sign in', function (body, close) {
      var email = el('input', { class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
      var pass = el('input', {
        class: 'input', type: 'password', placeholder: '••••••••',
        autocomplete: isSignUp ? 'new-password' : 'current-password'
      });

      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Email' }), email]));
      body.appendChild(el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Password' }), pass]));

      if (isSignUp) {
        body.appendChild(el('p', { class: 'hint', style: 'margin:-6px 0 10px', text: 'At least 6 characters.' }));
      }

      var err = el('p', { class: 'hint', style: 'color:var(--bad);display:none' });
      body.appendChild(err);

      var submit = el('button', {
        class: 'btn btn-primary', text: isSignUp ? 'Create account' : 'Sign in',
        onClick: function () {
          var e = email.value.trim();
          var p = pass.value;
          if (!e || !p) { err.textContent = 'Email and password are both required.'; err.style.display = ''; return; }
          if (isSignUp && p.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.style.display = ''; return; }

          submit.disabled = true;
          submit.textContent = isSignUp ? 'Creating…' : 'Signing in…';
          err.style.display = 'none';

          var action = isSignUp ? Sync.signUp(e, p) : Sync.signIn(e, p);
          action.then(function (res) {
            if (isSignUp && res && res.needsConfirmation) {
              close();
              UI.toast('Check your email to confirm, then sign in');
              return;
            }
            close();
            UI.toast('Signed in — syncing');
            // A fresh device should pull the full history, not just
            // whatever changed since a lastSync it never had.
            return Sync.pullAll()
              .then(function () { UI.toast(Sync.state.message || 'Synced'); })
              .catch(function (e2) { UI.toast(e2.message || 'Sync failed'); });
          }).catch(function (e2) {
            err.textContent = e2.message || 'Something went wrong.';
            err.style.display = '';
            submit.disabled = false;
            submit.textContent = isSignUp ? 'Create account' : 'Sign in';
          });
        }
      });

      body.appendChild(el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: close }),
        submit
      ]));

      body.appendChild(el('button', {
        class: 'link-btn', style: 'display:block;margin:16px auto 0',
        text: isSignUp ? 'Already have an account? Sign in' : 'Need an account? Sign up',
        onClick: function () { close(); openAuthForm(isSignUp ? 'signin' : 'signup'); }
      }));

      pass.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); submit.click(); }
      });
    });
  }

  function exportData() {
    DB.exportAll().then(function (dump) {
      var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'chrona-backup-' + S.todayKey() + '.json' });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      UI.toast('Backup downloaded');
    });
  }

  function importData() {
    var input = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var dump;
        try { dump = JSON.parse(reader.result); }
        catch (e) { UI.toast('That file is not valid JSON'); return; }
        DB.importAll(dump)
          .then(function () { UI.toast('Restored — reloading'); setTimeout(function () { location.reload(); }, 700); })
          .catch(function (err) { UI.toast(err.message || 'Import failed'); });
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () { document.body.removeChild(input); }, 1000);
  }

  global.Views = {
    renderToday: renderToday, tickTimer: tickTimer,
    goToDay: goToDay, resetDay: resetDay, currentDay: currentDay, isToday: isToday,
    checkRunaway: checkRunaway,
    renderTasks: renderTasks, setTaskFilter: setTaskFilter,
    renderHabits: renderHabits,
    renderStats: renderStats, setStatsRange: setStatsRange,
    openStartPicker: openStartPicker, openAccount: openAccount,
    openAuthForm: openAuthForm, openConnectForm: openConnectForm,
    openActivityForm: openActivityForm, openActivityManager: openActivityManager,
    openTaskForm: openTaskForm, openHabitForm: openHabitForm,
    openEntryForm: openEntryForm, openSettings: openSettings
  };
})(window);
