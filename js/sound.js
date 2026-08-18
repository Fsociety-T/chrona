/* ═══════════════════════════════════════════════════════════════
   sound.js — short synthesized cues for start / stop / completion

   The tones are generated with the Web Audio API rather than loaded
   from files: nothing to download, nothing to bundle, and it stays
   tiny inside the APK.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var ctx = null;
  var enabled = true;
  var volume = 0.5;

  /* ── preferences ──────────────────────────────────────────── */
  try {
    var savedOn = localStorage.getItem('chrona:sound');
    if (savedOn !== null) enabled = savedOn === '1';
    var savedVol = parseFloat(localStorage.getItem('chrona:volume'));
    if (!isNaN(savedVol)) volume = Math.min(1, Math.max(0, savedVol));
  } catch (e) { /* storage blocked — keep defaults */ }

  function isOn() { return enabled; }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem('chrona:sound', enabled ? '1' : '0'); } catch (e) {}
    if (enabled) play('start');   // let them hear what they just switched on
  }

  function getVolume() { return volume; }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem('chrona:volume', String(volume)); } catch (e) {}
  }

  /* ── context ──────────────────────────────────────────────── */
  function audio() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    // Browsers start the context suspended until a user gesture.
    // Every play() call here originates from a tap, so this is the moment.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ── one note ─────────────────────────────────────────────── */
  /* freq: Hz · at: seconds from now · dur: seconds
     type: oscillator wave · peak: relative loudness (0-1) */
  function note(freq, at, dur, type, peak) {
    var c = audio();
    if (!c) return;

    var t0 = c.currentTime + at;
    var osc = c.createOscillator();
    var gain = c.createGain();

    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);

    // A quick fade in and an exponential tail — a raw square envelope
    // would click audibly at both ends.
    var top = peak * volume;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, top), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /* A note plus a quiet octave above, which reads as "bell" rather
     than "test tone". */
  function chime(freq, at, dur, peak) {
    note(freq, at, dur, 'sine', peak);
    note(freq * 2, at, dur * 0.6, 'sine', peak * 0.22);
  }

  /* ── the cues ─────────────────────────────────────────────── */
  var CUES = {
    // Two notes rising: "we're off".
    start: function (t) {
      chime(587.33, t,         0.18, 0.30);  // D5
      chime(880.00, t + 0.085, 0.30, 0.30);  // A5
    },

    // The same interval falling: "that's logged".
    stop: function (t) {
      chime(880.00, t,         0.16, 0.26);  // A5
      chime(587.33, t + 0.085, 0.34, 0.26);  // D5
    },

    // Switching tasks — one soft blip, so it doesn't sound like a
    // stop immediately followed by a start.
    switch: function (t) {
      chime(740.00, t, 0.16, 0.22);          // F#5
    },

    // Ticking something off: a major arpeggio.
    done: function (t) {
      chime(523.25, t,         0.16, 0.26);  // C5
      chime(659.25, t + 0.075, 0.16, 0.26);  // E5
      chime(783.99, t + 0.150, 0.34, 0.28);  // G5
    },

    // A habit hitting its daily target — same shape plus a closing
    // octave, so it lands like an arrival.
    goal: function (t) {
      chime(523.25, t,         0.15, 0.24);  // C5
      chime(659.25, t + 0.070, 0.15, 0.26);  // E5
      chime(783.99, t + 0.140, 0.15, 0.28);  // G5
      chime(1046.5, t + 0.215, 0.42, 0.30);  // C6
    },

    // Pausing: two notes stepping down, softer than a full stop.
    pause: function (t) {
      chime(659.25, t,         0.13, 0.20);  // E5
      chime(523.25, t + 0.070, 0.22, 0.20);  // C5
    },

    // Resuming: the same pair the other way up.
    resume: function (t) {
      chime(523.25, t,         0.13, 0.20);  // C5
      chime(659.25, t + 0.070, 0.24, 0.22);  // E5
    },

    // Undoing a completion: a short low blip.
    undo: function (t) {
      note(392.00, t, 0.14, 'sine', 0.18);
    }
  };

  /* delay: seconds to wait before the cue starts. Used to queue a cue
     behind one that is already sounding — the goal fanfare after a stop
     chime, for instance — instead of letting them clash. */
  function play(name, delay) {
    if (!enabled) return;
    var cue = CUES[name];
    if (!cue) return;
    try { cue(delay || 0); } catch (e) { /* audio is a nicety, never break the app for it */ }
  }

  global.Sound = {
    play: play,
    isOn: isOn, setEnabled: setEnabled,
    getVolume: getVolume, setVolume: setVolume,
    cues: Object.keys(CUES)
  };
})(window);
