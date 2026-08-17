/* Writes the Android launcher icons into the Capacitor android project.

   Runs in CI after `npx cap add android`, replacing Capacitor's default
   Ionic logo with the Chrona mark. Safe to skip if android/ isn't there.

   Run:  node tools/android-icons.js
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { draw, solid } = require('./icon-lib');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

if (!fs.existsSync(RES)) {
  console.log('android/ not present — skipping launcher icons.');
  process.exit(0);
}

/* Legacy square + round icons, one per density. */
const DENSITIES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

/* Adaptive icons: the foreground layer is drawn at 108dp with the glyph
   inside the inner 72dp safe zone, over a solid background layer. */
const FOREGROUND = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432
};

const BG_COLOR = '#0b0d14';

let written = 0;

for (const [dir, size] of Object.entries(DENSITIES)) {
  const target = path.join(RES, dir);
  fs.mkdirSync(target, { recursive: true });

  fs.writeFileSync(path.join(target, 'ic_launcher.png'), draw(size, {}));
  fs.writeFileSync(path.join(target, 'ic_launcher_round.png'), draw(size, { maskable: true }));
  written += 2;
}

for (const [dir, size] of Object.entries(FOREGROUND)) {
  const target = path.join(RES, dir);
  fs.mkdirSync(target, { recursive: true });

  fs.writeFileSync(path.join(target, 'ic_launcher_foreground.png'), draw(size, { transparent: true }));
  fs.writeFileSync(path.join(target, 'ic_launcher_background.png'), solid(size, BG_COLOR));
  written += 2;
}

/* Point the adaptive icon at our two layers. */
const anyDpi = path.join(RES, 'mipmap-anydpi-v26');
fs.mkdirSync(anyDpi, { recursive: true });

const adaptiveXml =
`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;

fs.writeFileSync(path.join(anyDpi, 'ic_launcher.xml'), adaptiveXml);
fs.writeFileSync(path.join(anyDpi, 'ic_launcher_round.xml'), adaptiveXml);
written += 2;

/* Match the splash/window background to the app's own background so
   launching doesn't flash white. */
const valuesDir = path.join(RES, 'values');
fs.mkdirSync(valuesDir, { recursive: true });
const colorsPath = path.join(valuesDir, 'colors.xml');
if (fs.existsSync(colorsPath)) {
  let xml = fs.readFileSync(colorsPath, 'utf8');
  xml = xml.replace(/(<color name="colorPrimaryDark">)[^<]*(<\/color>)/, '$1' + BG_COLOR + '$2');
  fs.writeFileSync(colorsPath, xml);
}

console.log('Wrote ' + written + ' Android icon files.');
