'use strict';
// Optional browser test host. Launch with: node scripts/browser-host.cjs <chromium-executable>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) throw new Error('Provide an installed Chromium testing executable.');
const extension = path.resolve(process.argv[3] || path.join(__dirname, '../extension'));
if (!fs.existsSync(path.join(extension, 'manifest.json'))) throw new Error('Extension directory has no manifest.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcc-browser-'));
const child = spawn(executable, [
  '--remote-debugging-port=9335', '--remote-debugging-address=127.0.0.1',
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-component-update', '--disable-background-networking',
  '--disable-features=Translate', '--window-size=1000,800',
  '--user-data-dir=' + profile, '--load-extension=' + extension,
  '--disable-extensions-except=' + extension, 'about:blank'
], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
console.log('Isolated extension browser: CDP http://127.0.0.1:9335');
