'use strict';
// Isolated browser-only copy. Production manifest still requests the origin on Save.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcc-index-test-'));
fs.cpSync(path.join(__dirname, '../extension'), directory, { recursive: true });
const manifestPath = path.join(directory, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'https://index-translate.bilibili.com/*'])];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(directory);
