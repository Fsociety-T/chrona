/* ═══════════════════════════════════════════════════════════════
   ui.js — DOM helpers, formatting, sheets, toasts
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── DOM ──────────────────────────────────────────────────── */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── formatting ───────────────────────────────────────────── */

  /* 1h 05m — the readable form used everywhere in summaries. */
  function fmtDuration(ms) {
    var totalMin = Math.floor(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h === 0) return m + 'm';
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  /* Compact form for tight spots: 1.5h / 45m */
  function fmtShort(ms) {
    var min = Math.round(ms / 60000);
    if (min < 60) return min + 'm';
    var h = min / 60;
    return (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)) + 'h';
  }

  /* Live clock form: 12:34 or 1:02:03 */
  function fmtClock(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtDayLong(dayStr) {
    var p = dayStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* Weekday of a timestamp — "Mon", "Tue". Used when a session runs over
     midnight and the times alone would be ambiguous. */
  function fmtDayShortName(ts) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  }

  function fmtDayShort(dayStr) {
    var p = dayStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
  }

  /* Convert a local datetime-local input value to a timestamp, and back. */
  function toLocalInput(ts) {
    var d = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ── sheet ────────────────────────────────────────────────── */
  var sheetEl, scrimEl, sheetBody, sheetTitle;
  var onCloseHook = null;

  function initSheet() {
    sheetEl = $('#sheet');
    scrimEl = $('#scrim');
    sheetBody = $('#sheetBody');
    sheetTitle = $('#sheetTitle');
    scrimEl.addEventListener('click', closeSheet);
    $('#sheetClose').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !sheetEl.hidden) closeSheet();
    });
  }

  /* openSheet(title, buildFn) — buildFn receives the body element and
     a close() callback, and fills the body however it likes. */
  function openSheet(title, build, onClose) {
    sheetTitle.textContent = title;
    clear(sheetBody);
    onCloseHook = onClose || null;
    build(sheetBody, closeSheet);
    scrimEl.hidden = false;
    sheetEl.hidden = false;
    document.body.style.overflow = 'hidden';
    // Focus the first input so typing starts immediately.
    var first = sheetBody.querySelector('input, textarea, select');
    if (first) setTimeout(function () { first.focus(); }, 120);
  }

  function closeSheet() {
    if (sheetEl.hidden) return;
    sheetEl.hidden = true;
    scrimEl.hidden = true;
    document.body.style.overflow = '';
    clear(sheetBody);
    if (onCloseHook) { var f = onCloseHook; onCloseHook = null; f(); }
  }

  function sheetOpen() { return sheetEl && !sheetEl.hidden; }

  /* ── toast ────────────────────────────────────────────────── */
  function toast(msg, ms) {
    var wrap = $('#toastWrap');
    var t = el('div', { class: 'toast', text: msg });
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('is-out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, ms || 2200);
  }

  /* ── confirm dialog (sheet-based, no window.confirm) ──────── */
  function confirmSheet(title, message, confirmLabel, onYes) {
    openSheet(title, function (body, close) {
      body.appendChild(el('p', { class: 'hint', text: message, style: 'font-size:14px;margin:0 0 4px' }));
      body.appendChild(el('div', { class: 'sheet-actions' }, [
        el('button', { class: 'btn btn-ghost', onClick: close, text: 'Cancel' }),
        el('button', {
          class: 'btn btn-danger', text: confirmLabel || 'Delete',
          onClick: function () { close(); onYes(); }
        })
      ]));
    });
  }

  /* ── colour helpers ───────────────────────────────────────── */
  function hexToRgba(hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  global.UI = {
    $: $, $$: $$, el: el, clear: clear, escapeHtml: escapeHtml,
    fmtDuration: fmtDuration, fmtShort: fmtShort, fmtClock: fmtClock,
    fmtTime: fmtTime, fmtDayLong: fmtDayLong, fmtDayShort: fmtDayShort,
    fmtDayShortName: fmtDayShortName,
    toLocalInput: toLocalInput,
    initSheet: initSheet, openSheet: openSheet, closeSheet: closeSheet, sheetOpen: sheetOpen,
    toast: toast, confirmSheet: confirmSheet, hexToRgba: hexToRgba
  };
})(window);
