'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest must be MV3');
const pages = [manifest.action.default_popup, manifest.options_ui?.page].filter(Boolean);
const files = [manifest.background.service_worker, ...pages, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), ...manifest.content_scripts.flatMap(c => [...c.js, ...c.css])];
for (const file of new Set(files)) {
  if (!fs.statSync(path.join(ext, file)).isFile()) throw new Error('Missing manifest resource: ' + file);
}
for (const file of fs.readdirSync(ext).filter(f => f.endsWith('.js'))) cp.execFileSync(process.execPath, ['--check', path.join(ext, file)], { stdio: 'inherit' });
for (const page of pages) {
  const html = fs.readFileSync(path.join(ext, page), 'utf8');
  if (/<script[^>]*>\s*[^<\s]|\son\w+\s*=|<script[^>]+src=["']https?:/i.test(html)) throw new Error(page + ' contains inline/remote executable content');
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (!/^(?:https?:|#)/.test(match[1]) && !fs.existsSync(path.join(ext, match[1]))) throw new Error('Missing page asset: ' + match[1]);
  }
}
if (manifest.host_permissions.includes('https://*/*')) throw new Error('Broad AI access must be optional, not mandatory.');
console.log('Manifest resources, JavaScript syntax and popup/options CSP checks passed.');
