'use strict';
// Temporary test fixture server, loopback only. Does not serve a replacement app.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
  const relative = requestPath === '/results' ? 'tests/search-fixture.html' : ['/search-fixture-api.js', '/search-browser-checks.js'].includes(requestPath) ? 'tests' + requestPath : requestPath.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(target, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
server.listen(0, '127.0.0.1', () => console.log('Search fixture: http://127.0.0.1:' + server.address().port + '/results?search_query=' + encodeURIComponent('Windows 11 卡顿怎么解决')));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
