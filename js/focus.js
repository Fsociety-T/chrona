/* ═══════════════════════════════════════════════════════════════
   focus.js — the focus screen

   While a session runs, Chrona hands the whole screen to one thing: the
   activity you chose and the clock counting it. The rest of the app —
   tasks, habits, the nav, yesterday's timeline — is behind the veil and
   stays there until you stop, pause, or deliberately leave.

   What this cannot do, and does not pretend to:

   It cannot lock your phone or keep you out of other apps. No web page
   can, in any browser, and a page that claimed otherwise would be lying
   to you. What it does instead is remove every accidental exit inside
   Chrona, hold the screen awake so the session is visible, and count the
   times you left — because a number you have to look at afterwards does
   more than a door you cannot open.

   Leaving is a deliberate hold, not a tap. The timer keeps running when
   you go; leaving the focus screen is not stopping the session, and the
   two are kept separate on purpose.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var LS_ON = 'chrona:focus';
  var HOLD_MS = 800;

  var el = UI.el, clear = UI.clear;

  var veil = null;          // the overlay element, once built
  var ticker = null;        // 1s interval, only while the veil is up
  var wakeLock = null;
  var dismissedFor = null;  // sessionStart of a session the user stepped out of
  var awayCount = 0;
  var awayFor = null;       // which session awayCount belongs to

  /* ── the setting ──────────────────────────────────────────── */

  function isOn() {
    try { return localStorage.getItem(LS_ON) === '1'; } catch (e) { return false; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(LS_ON, on ? '1' : '0'); } catch (e) {}
    if (!on) hide();
    sync();
  }

  /* ── screen wake lock ─────────────────────────────────────────
     Held only while the veil is up, and re-taken when the page comes
     back: the browser drops the lock whenever the tab is hidden, so
     acquiring it once would quietly stop working after the first switch
     away — the exact moment it matters most. */

  function takeWakeLock() {
    if (wakeLock || !navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* denied, or unsupported in this context */ });
  }

  function dropWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  /* ── building the veil ────────────────────────────────────── */

  function activityFor(r) {
    if (!r || !r.activityId) return null;
    return Store.state.activities.filter(function (a) { return a.id === r.activityId; })[0] || null;
  }

  function build() {
    var node = el('div', {
      class: 'focus', id: 'focusVeil',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Focus session'
    });

    node.appendChild(el('div', { class: 'focus-glow', id: 'focusGlow' }));

    var head = el('div', { class: 'focus-head' });
    head.appendChild(el('div', { class: 'focus-icon', id: 'focusIcon' }));
    head.appendChild(el('div', { class: 'focus-name', id: 'focusName' }));
    head.appendChild(el('div', { class: 'focus-sub hint', id: 'focusSub' }));
    node.appendChild(head);

    node.appendChild(el('div', { class: 'focus-clock mono', id: 'focusClock', text: '0:00' }));
    node.appendChild(el('div', { class: 'focus-since hint', id: 'focusSince' }));

    var controls = el('div', { class: 'focus-controls' });
    controls.appendChild(el('button', {
      class: 'btn btn-ghost focus-btn', id: 'focusPause',
      onClick: function () {
        if (Store.isPaused()) Store.resume();
        else Store.pause();
      }
    }));
    controls.appendChild(el('button', {
      class: 'btn btn-primary focus-btn', id: 'focusStop', text: 'Finish',
      onClick: function () {
        // Read the clock before stopping — afterwards there is no session
        // left to ask, and the toast would report zero.
        var ms = Store.elapsed();
        Store.stop().then(function () { UI.toast('Saved — ' + UI.fmtDuration(ms)); });
      }
    }));
    node.appendChild(controls);

    node.appendChild(el('div', { class: 'focus-away hint', id: 'focusAway' }));

    /* Leaving is a hold rather than a tap. The whole point of the screen
       is that no single mis-tap takes you out of it. */
    var leave = el('button', { class: 'focus-leave', id: 'focusLeave' }, [
      el('span', { class: 'focus-leave-fill', id: 'focusLeaveFill' }),
      el('span', { class: 'focus-leave-text', text: 'Hold to leave' })
    ]);
    wireHold(leave);
    node.appendChild(leave);

    return node;
  }

  function wireHold(button) {
    var timer = null;

    function begin(e) {
      if (e.button != null && e.button !== 0) return;   // ignore right-click
      button.classList.add('is-holding');
      timer = setTimeout(function () {
        timer = null;
        button.classList.remove('is-holding');
        var r = Store.state.running;
        dismissedFor = r ? (r.sessionStart || r.start) : null;
        hide();
        UI.toast('Still running — the timer kept going');
      }, HOLD_MS);
    }

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      button.classList.remove('is-holding');
    }

    button.addEventListener('pointerdown', begin);
    button.addEventListener('pointerup', cancel);
    button.addEventListener('pointerleave', cancel);
    button.addEventListener('pointercancel', cancel);
  }

  /* ── painting ─────────────────────────────────────────────── */

  function paint() {
    if (!veil) return;
    var r = Store.state.running;
    if (!r) return;

    var act = activityFor(r);
    var paused = Store.isPaused();

    var icon = document.getElementById('focusIcon');
    var glow = document.getElementById('focusGlow');
    icon.textContent = act ? (act.icon || '⏱') : '⏱';
    if (act && act.color) {
      icon.style.background = UI.hexToRgba(act.color, .16);
      icon.style.color = act.color;
      glow.style.background = 'radial-gradient(circle at 50% 0%, ' +
        UI.hexToRgba(act.color, .28) + ', transparent 62%)';
    }


    /* runningLabel() falls back to the activity name when no task or
       habit is attached, so showing the activity underneath would print
       the same words twice. */
    var label = Store.runningLabel();
    var sub = act && act.name && act.name !== label ? act.name : 'Tracking';
    document.getElementById('focusSub').textContent = paused ? 'Paused' : sub;
    document.getElementById('focusName').textContent = label;

    document.getElementById('focusClock').textContent = UI.fmtClock(Store.elapsed());
    document.getElementById('focusSince').textContent =
      'Started ' + UI.fmtTime(Store.sessionStart());

    document.getElementById('focusPause').textContent = paused ? 'Resume' : 'Pause';
    veil.classList.toggle('is-paused', paused);

    var away = document.getElementById('focusAway');
    away.textContent = awayCount
      ? 'You left the app ' + awayCount + (awayCount === 1 ? ' time' : ' times')
      : '';
  }

  /* ── show / hide ──────────────────────────────────────────── */

  function show() {
    if (veil) { paint(); return; }

    veil = build();
    document.body.appendChild(veil);
    document.body.classList.add('is-focused');

    // Let the element land before animating, or the transition is skipped.
    requestAnimationFrame(function () { if (veil) veil.classList.add('is-in'); });

    paint();
    ticker = setInterval(paint, 1000);
    takeWakeLock();
  }

  function hide() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    dropWakeLock();
    document.body.classList.remove('is-focused');

    if (!veil) return;
    var node = veil;
    veil = null;
    node.classList.remove('is-in');
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 220);
  }

  /* Decide, from the current state, whether the veil belongs on screen.
     Called on every store change, so starting, stopping, switching and a
     reload mid-session all route through one rule rather than each
     remembering to raise or lower it. */
  function sync() {
    var r = Store.state.running;

    if (!r) {                       // session over: forget everything about it
      dismissedFor = null;
      awayCount = 0;
      awayFor = null;
      hide();
      return;
    }

    var id = r.sessionStart || r.start;

    if (awayFor !== id) {           // a different session — reset its counter
      awayFor = id;
      awayCount = 0;
    }

    if (!isOn() || dismissedFor === id) { hide(); return; }
    show();
  }

  /* Step back into a session already under way. */
  function enter() {
    if (!Store.state.running) { UI.toast('Nothing is running'); return; }
    dismissedFor = null;
    show();
  }

  function active() { return !!veil; }

  /* ── wiring ───────────────────────────────────────────────── */

  function init() {
    Store.on(sync);

    document.addEventListener('visibilitychange', function () {
      if (!veil) return;
      if (document.hidden) {
        awayCount++;
      } else {
        takeWakeLock();             // the lock is dropped whenever we are hidden
        paint();
      }
    });

    /* Escape closes sheets everywhere else in the app. Here it would be
       the accidental exit this screen exists to prevent. */
    document.addEventListener('keydown', function (e) {
      if (veil && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); }
    }, true);

    sync();
  }

  global.Focus = {
    init: init, sync: sync, enter: enter, active: active,
    isOn: isOn, setEnabled: setEnabled
  };
})(window);
