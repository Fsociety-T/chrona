/* ═══════════════════════════════════════════════════════════════
   app.js — boot, routing, event wiring, the one-second tick
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var $ = UI.$, $$ = UI.$$;
  var S = Store;

  var current = 'today';
  var tickHandle = null;

  /* ── routing ──────────────────────────────────────────────── */
  function show(view) {
    // Coming back to Today should land on today, not wherever you had
    // paged back to earlier.
    if (view === 'today') Views.resetDay();
    current = view;
    $$('.view').forEach(function (v) { v.hidden = v.dataset.view !== view; });
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('is-on', b.dataset.nav === view); });
    try { localStorage.setItem('chrona:view', view); } catch (e) {}
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* Re-render only the visible view — cheap enough to do on every change. */
  function render() {
    if (!S.state.ready) return;
    if (current === 'today')  Views.renderToday();
    if (current === 'tasks')  Views.renderTasks();
    if (current === 'habits') Views.renderHabits();
    if (current === 'goals')  Views.renderGoals();
    if (current === 'stats')  Views.renderStats();
    syncTick();
  }

  /* ── the one-second tick, only while something is running ─── */
  function syncTick() {
    var running = !!S.state.running;
    if (running && !tickHandle) {
      tickHandle = setInterval(onTick, 1000);
    } else if (!running && tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function onTick() {
    Views.tickTimer();

    // Records that you were here. Only advances while the page is visible,
    // which is what makes "stop at last activity" meaningful later.
    if (!document.hidden) S.heartbeat();

    // Keep today's totals honest while the clock runs, but don't thrash
    // the whole timeline — refresh totals once a minute.
    if (current === 'today' && new Date().getSeconds() === 0) Views.renderToday();

    // Catches a timer that crosses the threshold while the app is open.
    if (new Date().getSeconds() === 30) Views.checkRunaway();
  }

  /* ── wiring ───────────────────────────────────────────────── */
  function wire() {
    // bottom nav
    $$('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.nav); });
    });

    /* The primary button always does whatever moves the session on:
       start it, pause it, or pick it back up. */
    function primaryAction() {
      if (!S.state.running) { Views.openStartPicker(); return; }
      if (S.isPaused()) {
        S.resume().then(function () { UI.toast('Resumed'); });
      } else {
        S.pause().then(function () { UI.toast('Paused — ' + UI.fmtDuration(S.elapsed()) + ' so far'); });
      }
    }

    /* Read the session total *before* stopping: afterwards the running
       record is gone, and the last segment alone would under-report a
       session that had been paused. */
    function stopSession() {
      var total = S.elapsed();
      S.stop().then(function (entry) {
        UI.toast(entry || total > 0 ? 'Logged ' + UI.fmtDuration(total) : 'Too short — discarded');
      });
    }

    $('#btnPrimary').addEventListener('click', primaryAction);
    $('#btnStop').addEventListener('click', stopSession);
    $('#btnSwitch').addEventListener('click', Views.openStartPicker);
    $('#liveBarInfo').addEventListener('click', function () {
      if (Focus.isOn() && S.state.running) Focus.enter();
    });
    $('#liveBarPause').addEventListener('click', primaryAction);
    $('#liveBarStop').addEventListener('click', stopSession);

    $('#btnManageActivities').addEventListener('click', Views.openActivityManager);
    // Wrapped, not passed directly: the click Event would otherwise arrive
    // as the `entry` argument and put the form into edit mode.
    $('#btnAddManual').addEventListener('click', function () { Views.openEntryForm(null); });

    // Day navigation on Today
    $('#dayPrev').addEventListener('click', function () {
      Views.goToDay(S.addDays(Views.currentDay(), -1));
    });
    $('#dayNext').addEventListener('click', function () {
      Views.goToDay(S.addDays(Views.currentDay(), 1));
    });
    $('#dayToday').addEventListener('click', function () {
      Views.goToDay(S.todayKey());
    });
    $('#btnSettings').addEventListener('click', Views.openSettings);
    $('#btnAccount').addEventListener('click', Views.openAccount);
    $('#syncBanner').addEventListener('click', Views.openAccount);

    // Sync status changes (signed in/out, sync finished) should repaint
    // the banner and badge immediately.
    Sync.on(function () { if (current === 'today') Views.renderToday(); });
    $('#btnNewTask').addEventListener('click', function () { Views.openTaskForm(null); });
    $('#btnNewHabit').addEventListener('click', function () { Views.openHabitForm(null); });
    $('#btnNewGoal').addEventListener('click', function () { Views.openGoalForm(null); });
    $('#btnAiSettings').addEventListener('click', Views.openAiSetup);

    $$('#goalFilter .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#goalFilter .seg-btn').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        Views.setGoalFilter(b.dataset.filter);
      });
    });

    // segmented controls
    $$('#taskFilter .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#taskFilter .seg-btn').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        Views.setTaskFilter(b.dataset.filter);
      });
    });

    $$('#statsRange .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#statsRange .seg-btn').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        Views.setStatsRange(parseInt(b.dataset.range, 10));
      });
    });

    // keyboard shortcuts, for desktop use
    document.addEventListener('keydown', function (e) {
      if (UI.sheetOpen()) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Space mirrors the primary button; Escape-adjacent 'x' stops.
      if (e.key === ' ') { e.preventDefault(); primaryAction(); }
      if (e.key === 'x' && S.state.running) stopSession();
      if (e.key === '1') show('today');
      if (e.key === '2') show('tasks');
      if (e.key === '3') show('habits');
      if (e.key === '4') show('goals');
      if (e.key === '5') show('stats');
      if (e.key === 'n' && current === 'tasks')  Views.openTaskForm(null);
      if (e.key === 'n' && current === 'habits') Views.openHabitForm(null);
      if (e.key === 'n' && current === 'goals')  Views.openGoalForm(null);
    });

    // Coming back to the app after it was backgrounded: the clock may have
    // drifted or the day may have rolled over, so redraw from scratch.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      render();
      // Returning after a long absence is exactly when a forgotten timer
      // shows up, so check before the heartbeat moves lastSeen forward.
      Views.checkRunaway();
    });

    // Re-render on any state change.
    S.on(render);
  }

  /* ── theme ────────────────────────────────────────────────── */
  function restoreTheme() {
    var saved;
    try { saved = localStorage.getItem('chrona:theme'); } catch (e) {}
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  }

  /* ── boot ─────────────────────────────────────────────────── */
  function boot() {
    restoreTheme();
    UI.initSheet();
    wire();

    Sync.load();

    S.init().then(function () {
      var saved;
      try { saved = localStorage.getItem('chrona:view'); } catch (e) {}
      show(saved && ['today', 'tasks', 'habits', 'goals', 'stats'].indexOf(saved) !== -1 ? saved : 'today');

      // Background sync only starts once the store is live, so the first
      // debounced run has real state to push.
      Sync.startAuto();

      // After the store, so a session restored from a reload raises the
      // focus screen instead of waiting for the next change.
      Focus.init();

      var boot = $('#boot');
      boot.classList.add('is-gone');
      setTimeout(function () { boot.remove(); }, 500);

      if (S.state.running) {
        // A timer that ran past the threshold while the app was closed is
        // the main case this catches; the prompt takes priority over the
        // reassuring toast.
        if (!Views.checkRunaway() && !UI.sheetOpen()) {
          UI.toast('Still tracking "' + S.runningLabel() + '"');
        }
      }
    }).catch(function (err) {
      console.error('[chrona] boot failed', err);
      $('#boot').innerHTML =
        '<div style="text-align:center;padding:24px;max-width:340px">' +
        '<div style="font-size:34px;margin-bottom:10px">⚠️</div>' +
        '<p style="font-weight:600;margin:0 0 6px">Could not start</p>' +
        '<p style="font-size:13px;color:#9aa3b8;margin:0">' + UI.escapeHtml(err.message || String(err)) + '</p>' +
        '</div>';
    });

    // Register the service worker so the app works offline / installs.
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      // A new worker taking over means the page is running code that has
      // just been replaced. Reload once so the fresh version is actually
      // what you see. The `hadController` guard stops the very first
      // install (where there was no previous worker) from looping.
      var hadController = !!navigator.serviceWorker.controller;
      var reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });

      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', function () {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              next.postMessage('skipWaiting');
            }
          });
        });
        reg.update();
      }).catch(function () { /* fine without it */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
