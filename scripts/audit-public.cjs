'use strict';
// Read-only public-source audit. Findings contain locations/categories, never matched values.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const skip = new Set(['.git', 'dist', 'design', 'node_modules', '.cache', 'coverage']);
const text = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.txt', '.py', '.html', '.css', '.yml', '.yaml', '.toml', '.sh', '.ps1', '.env', '.ini']);
const rules = [
  ['credential-token', /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['private-user-path', /[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/i],
  ['scrubbed-personal-marker', /\{\{(?:API_KEY|PASSWORD|USERNAME|PHONE|SECRET|TOKEN)_[A-Za-z0-9_]+\}\}/],
  ['credential-url', /https?:\/\/[^\s\/"'<>:]+:[^\s\/"'<>@]+@/],
  ['environment-file', /^\s*(?:OPENROUTER|SILICONFLOW|GITHUB|GH|OPENAI|ANTHROPIC)_(?:API_)?(?:KEY|TOKEN)\s*=\s*[^\s#]{8,}/]
];
let scanned = 0;
const findings = [];
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.has(item.name)) continue;
    const target = path.join(directory, item.name);
    if (item.isSymbolicLink()) { findings.push({ file: path.relative(root, target).replaceAll('\\', '/'), category: 'symlink-review' }); continue; }
    if (item.isDirectory()) { walk(target); continue; }
    if (!item.isFile() || (!text.has(path.extname(item.name).toLowerCase()) && !['LICENSE', '.gitignore', '.gitattributes'].includes(item.name))) continue;
    if (item.name === 'audit-public.cjs') continue;
    const data = fs.readFileSync(target, 'utf8'); scanned++;
    data.split(/\r?\n/).forEach((line, index) => {
      for (const [category, regex] of rules) {
        if (regex.test(line)) findings.push({ file: path.relative(root, target).replaceAll('\\', '/'), line: index + 1, category });
      }
    });
  }
}
walk(root);
console.log(JSON.stringify({ scanned, findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
