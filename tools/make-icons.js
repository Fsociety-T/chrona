/* Generates the PWA icons into icons/.
   Run:  node tools/make-icons.js       (or: npm run icons)
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { draw } = require('./icon-lib');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['icon-1024.png', 1024, {}]
];

for (const [name, size, opts] of targets) {
  const png = draw(size, opts);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('wrote icons/' + name + '  (' + size + 'px, ' + (png.length / 1024).toFixed(1) + ' KB)');
}

console.log('\nDone.');
