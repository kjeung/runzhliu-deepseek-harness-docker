#!/usr/bin/env node
'use strict';

// PROTOTYPE server for the admin variant explorer (#6).
// Static-ish, deliberately minimal: serve the prototype directory at
// /prototype-admin/ so the route name is part of the URL. No build step,
// no framework. Kill it, it's throwaway.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PROTOTYPE_DIR = path.join(__dirname);
const ROUTE_PREFIX = '/prototype-admin';
const PORT = Number(process.env.PROTOTYPE_PORT ?? 8787);
const ROOT = path.join(PROTOTYPE_DIR, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function notFound(response, message) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(message ?? 'not found');
}

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    notFound(response, 'bad request');
    return;
  }

  // Root of the app: send the prototype index.
  if (pathname === '/' || pathname === '') {
    response.writeHead(302, { location: ROUTE_PREFIX + '/index.html?variant=A' });
    response.end();
    return;
  }

  if (!pathname.startsWith(ROUTE_PREFIX)) {
    notFound(response, 'this server only serves ' + ROUTE_PREFIX);
    return;
  }

  const relative = pathname.slice(ROUTE_PREFIX.length) || '/index.html';
  const file = path.normalize(PROTOTYPE_DIR + relative);
  if (!file.startsWith(PROTOTYPE_DIR)) {
    notFound(response, 'forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      notFound(response, 'not found: ' + relative);
      return;
    }
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('PROTOTYPE admin variant explorer: http://127.0.0.1:' + PORT + ROUTE_PREFIX + '/index.html?variant=A');
  console.log('variants: ?variant=A | ?variant=B | ?variant=C (switch also via the floating bottom bar or ←/→)');
});
