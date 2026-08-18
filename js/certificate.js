/* ═══════════════════════════════════════════════════════════════
   certificate.js — draws an objective as a saveable card

   Two cards, same frame, different voice:

     a COMMITMENT card for an objective still running — what you are
     going to do, and who you are trying to become
     a CERTIFICATE for one you have achieved — what you did, and when

   Drawn on a <canvas> and exported as a PNG. No library, no server, no
   fonts to fetch: it works offline and adds nothing to the APK.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* 4:5 portrait — the shape that survives being shared without being
     cropped by everything. */
  var W = 1080, H = 1350;

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /* ── profile (name + ambition) ────────────────────────────── */
  var LS_NAME = 'chrona:certName';
  var LS_WANT = 'chrona:certWant';

  function getName() {
    try {
      var v = localStorage.getItem(LS_NAME);
      if (v) return v;
    } catch (e) {}
    // Fall back to the account: an email's local part is usually a name.
    if (global.Sync && Sync.signedIn()) {
      var email = Sync.userEmail() || '';
      var local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
      if (local) return local.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
    return '';
  }

  function setName(v) { try { localStorage.setItem(LS_NAME, v); } catch (e) {} }

  function getWant() {
    try { return localStorage.getItem(LS_WANT) || ''; } catch (e) { return ''; }
  }
  function setWant(v) { try { localStorage.setItem(LS_WANT, v); } catch (e) {} }

  /* ── small drawing helpers ────────────────────────────────── */

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* Wrap text to a width, capped at `maxLines` with an ellipsis.
     Returns the y position just below the block it drew. */
  function wrap(c, text, x, y, maxW, lineH, maxLines) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [];
    var line = '';

    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(test).width > maxW && line) {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines) break;
      } else {
        line = test;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);

    // If anything was left over, mark the last line as truncated.
    if (lines.length === maxLines) {
      var used = lines.join(' ').split(/\s+/).length;
      if (used < words.length) {
        var last = lines[maxLines - 1];
        while (c.measureText(last + '…').width > maxW && last.length > 1) {
          last = last.slice(0, -1);
        }
        lines[maxLines - 1] = last + '…';
      }
    }

    lines.forEach(function (l, i) { c.fillText(l, x, y + i * lineH); });
    return y + lines.length * lineH;
  }

  function centerText(c, text, y, font, color, letterSpacing) {
    c.font = font;
    c.fillStyle = color;
    c.textAlign = 'center';
    if (letterSpacing && c.letterSpacing !== undefined) c.letterSpacing = letterSpacing;
    c.fillText(text, W / 2, y);
    if (c.letterSpacing !== undefined) c.letterSpacing = '0px';
  }

  /* ── the card ─────────────────────────────────────────────── */

  /* opts: { objective, progress, name, want, light } */
  function draw(canvas, opts) {
    var o = opts.objective;
    var p = opts.progress;
    var achieved = !!o.achievedAt;
    var light = !!opts.light;

    var ink   = light ? '#0d0d10' : '#f4f4f5';
    var dim   = light ? '#55555f' : '#a1a1aa';
    var mute  = light ? '#8a8a94' : '#6b6b72';
    var paper = light ? '#f2f3f6' : '#0b0b0e';
    var panel = light ? '#ffffff' : '#141419';
    var edge  = light ? '#e2e4ea' : '#26262e';
    var accent = opts.accent || (light ? '#0d0d10' : '#f4f4f5');

    canvas.width = W;
    canvas.height = H;
    var c = canvas.getContext('2d');

    /* ground */
    c.fillStyle = paper;
    c.fillRect(0, 0, W, H);

    /* a soft light from above, so the card isn't a flat rectangle */
    var glow = c.createRadialGradient(W / 2, -120, 40, W / 2, 420, 900);
    glow.addColorStop(0, light ? 'rgba(0,0,0,.05)' : 'rgba(255,255,255,.09)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, W, H);

    /* inner panel */
    var m = 54;
    c.save();
    c.shadowColor = light ? 'rgba(80,84,100,.18)' : 'rgba(0,0,0,.6)';
    c.shadowBlur = 40;
    c.shadowOffsetY = 14;
    roundRect(c, m, m, W - m * 2, H - m * 2, 44);
    c.fillStyle = panel;
    c.fill();
    c.restore();

    /* hairline frame, inset a little from the panel edge */
    roundRect(c, m + 18, m + 18, W - (m + 18) * 2, H - (m + 18) * 2, 30);
    c.strokeStyle = edge;
    c.lineWidth = 2;
    c.stroke();

    /* ── header ── */
    centerText(c, '⏱  C H R O N A', m + 108, '600 30px ' + FONT, mute, '2px');

    centerText(c,
      achieved ? 'CERTIFICATE OF ACHIEVEMENT' : 'A COMMITMENT',
      m + 178, '800 34px ' + FONT, accent, '6px');

    /* rule */
    c.beginPath();
    c.moveTo(W / 2 - 90, m + 210);
    c.lineTo(W / 2 + 90, m + 210);
    c.strokeStyle = edge;
    c.lineWidth = 3;
    c.stroke();

    /* ── name ── */
    var y = m + 300;
    centerText(c, achieved ? 'Awarded to' : 'Made by', y, '400 27px ' + FONT, mute);

    y += 74;
    c.textAlign = 'center';
    c.fillStyle = ink;
    var name = (opts.name || '').trim() || 'Your name';
    // Long names have to shrink rather than overflow the frame.
    var nameSize = 74;
    do {
      c.font = '800 ' + nameSize + 'px ' + FONT;
      nameSize -= 3;
    } while (c.measureText(name).width > W - m * 2 - 120 && nameSize > 30);
    c.fillText(name, W / 2, y);

    /* ── the ambition ── */
    var want = (opts.want || '').trim();
    if (want) {
      y += 78;
      centerText(c, achieved ? 'ON THE WAY TO BECOMING' : 'I WANT TO BE',
                 y, '700 22px ' + FONT, mute, '4px');

      y += 58;
      c.font = 'italic 600 44px ' + FONT;
      c.fillStyle = accent;
      c.textAlign = 'center';
      y = wrap(c, '“' + want + '”', W / 2, y, W - m * 2 - 140, 58, 2);
      y -= 14;
    }

    /* ── the objective ── */
    y += 96;
    centerText(c, achieved ? 'BY COMPLETING' : 'MY OBJECTIVE',
               y, '700 22px ' + FONT, mute, '4px');

    y += 62;
    c.font = '700 46px ' + FONT;
    c.fillStyle = ink;
    c.textAlign = 'center';
    y = wrap(c, o.title, W / 2, y, W - m * 2 - 120, 60, 2);

    /* target line */
    y += 46;
    var targetText;
    if (o.metric === 'sessions') {
      var n = Math.round(o.target);
      targetText = n + (n === 1 ? ' session' : ' sessions');
    } else {
      var h = o.target % 1 ? o.target : Math.round(o.target);
      targetText = h + (h === 1 ? ' hour' : ' hours');
    }
    if (opts.scope) targetText += ' · ' + opts.scope;
    centerText(c, targetText, y, '500 30px ' + FONT, dim);
    var afterTarget = y;

    /* ── progress ── */
    var barY = H - m - 250;
    var barX = m + 90;
    var barW = W - (m + 90) * 2;
    var pct = Math.max(0, Math.min(100, p.pct));

    roundRect(c, barX, barY, barW, 16, 8);
    c.fillStyle = light ? '#e6e7ec' : '#1e1e25';
    c.fill();

    if (pct > 0) {
      roundRect(c, barX, barY, Math.max(16, barW * (pct / 100)), 16, 8);
      c.fillStyle = accent;
      c.fill();
    }

    centerText(c, Math.round(pct) + '% complete', barY + 62, '600 28px ' + FONT, dim);

    /* ── footer ── */
    var footY = H - m - 108;

    if (achieved) {
      var d = new Date(o.achievedAt);
      centerText(c, 'Achieved ' + d.toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', year: 'numeric' }),
        footY, '600 30px ' + FONT, ink);
    } else {
      centerText(c, 'By ' + fmtDay(o.toDay), footY, '600 30px ' + FONT, ink);
    }

    centerText(c, achieved ? 'Every hour of it was tracked.' : 'Signed, and being tracked.',
               footY + 46, '400 25px ' + FONT, mute);

    /* Achievement seal.

       It sits centred in the space between the objective and the
       progress bar, not in a corner: the header runs nearly the full
       width, and a corner seal clipped the end of "ACHIEVEMENT". This
       also fills what was otherwise a hole in the middle of the card. */
    if (achieved) {
      var sy = Math.round((afterTarget + barY) / 2) + 8;
      var r = 52;

      c.beginPath();
      c.arc(W / 2, sy, r, 0, Math.PI * 2);
      c.fillStyle = accent;
      c.fill();

      // A thin ring around it, so it reads as a stamp rather than a dot.
      c.beginPath();
      c.arc(W / 2, sy, r + 12, 0, Math.PI * 2);
      c.strokeStyle = accent;
      c.globalAlpha = 0.28;
      c.lineWidth = 3;
      c.stroke();
      c.globalAlpha = 1;

      c.font = '800 46px ' + FONT;
      c.fillStyle = light ? '#ffffff' : '#0b0b0e';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('✓', W / 2, sy + 2);
      c.textBaseline = 'alphabetic';
    }

    return canvas;
  }

  function fmtDay(dayStr) {
    var p = String(dayStr).split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ── export ───────────────────────────────────────────────── */

  function fileName(o) {
    var slug = String(o.title || 'objective')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return 'chrona-' + (o.achievedAt ? 'certificate' : 'commitment') + '-' + (slug || 'card') + '.png';
  }

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not render the image.')); }, 'image/png');
      else reject(new Error('This browser cannot export images.'));
    });
  }

  function download(canvas, o) {
    return toBlob(canvas).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName(o);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return true;
    });
  }

  /* Native share sheet, where the browser supports sharing files. */
  function canShare() {
    return !!(navigator.canShare && navigator.share);
  }

  function share(canvas, o) {
    return toBlob(canvas).then(function (blob) {
      var file = new File([blob], fileName(o), { type: 'image/png' });
      if (!navigator.canShare || !navigator.canShare({ files: [file] })) {
        // Not shareable here — saving is still better than failing.
        return download(canvas, o);
      }
      return navigator.share({
        files: [file],
        title: o.title,
        text: o.achievedAt ? 'Achieved: ' + o.title : 'Working on: ' + o.title
      }).then(function () { return true; });
    });
  }

  global.Certificate = {
    draw: draw, download: download, share: share, canShare: canShare,
    getName: getName, setName: setName, getWant: getWant, setWant: setWant,
    WIDTH: W, HEIGHT: H
  };
})(window);
