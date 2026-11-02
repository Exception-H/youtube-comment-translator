'use strict';
// Copy the working extension/ directory over dist/extension, which is the folder
// loaded as an unpacked extension. dist/ is git-ignored.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extension');
const target = path.join(root, 'dist', 'extension');

if (!fs.existsSync(path.join(source, 'manifest.json'))) {
  console.error('extension/manifest.json not found');
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
console.log(`Synced extension -> dist/extension (v${manifest.version})`);
