/* Copies the app's shippable files into www/ — the folder Capacitor
   packages into the Android APK, and the folder GitHub Pages serves.

   Keeping this separate from the repo root means node_modules, the
   Android project, and tooling never end up inside the app bundle.

   Run:  node tools/build-www.js
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

/* Files and folders that make up the actual app. */
const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'icons'
];

function rimraf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function copy(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dest, name));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

rimraf(OUT);
fs.mkdirSync(OUT, { recursive: true });

let count = 0;
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.warn('  skip (missing): ' + item);
    continue;
  }
  copy(src, path.join(OUT, item));
  count++;
}

/* Cache-bust the service worker on every build so returning users
   actually get the new assets instead of the cached ones. */
const swPath = path.join(OUT, 'sw.js');
if (fs.existsSync(swPath)) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const sw = fs.readFileSync(swPath, 'utf8').replace(/chrona-v[\w.-]+/, 'chrona-' + stamp);
  fs.writeFileSync(swPath, sw);
}

console.log('Built www/ — ' + count + ' items copied.');
