'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const {
  createProxy,
  dshCookieName,
  isTrustedHost,
  normalizeAuthority,
  parseTrustedHosts,
} = require('./dsh-web-proxy.cjs');

function createUpstream() {
  const state = {
    validToken: 'good-token',
    cookieValue: 'v1.payload.signature',
    rejectInjectedCookie: false,
    multiCookie: false,
  };
  const server = http.createServer((req, res) => {
    const authority = normalizeAuthority(req.headers.host);
    const expected = dshCookieName(authority);
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim());
    const hasValidCookie = cookies.some(cookie => cookie === expected + '=' + state.cookieValue);
    const url = new URL(req.url || '/', 'http://' + authority);

    if (url.pathname === '/echo') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-echo': 'yes' });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.write('data: second\n\n');
        res.end();
      }, 120);
      return;
    }
    if (url.pathname === '/gzip') {
      const body = zlib.gzipSync(Buffer.from('gzip-payload'));
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/thing') {
      res.writeHead(hasValidCookie ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: hasValidCookie }));
      return;
    }
    if (url.pathname !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const token = url.searchParams.get('token');
    if (token !== null) {
      if (token === state.validToken) {
        const cookies = [expected + '=' + state.cookieValue + '; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'];
        if (state.multiCookie) cookies.push('other-cookie=1; Path=/');
        res.writeHead(303, {
          location: './',
          'set-cookie': cookies,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end();
      } else {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('bad token');
      }
      return;
    }
    if (hasValidCookie && !state.rejectInjectedCookie) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>INDEX' + url.search + '</body></html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('dsh web authentication required');
  });
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: test-accept\r\n\r\n');
    socket.on('data', data => socket.write(data));
    socket.on('error', () => socket.destroy());
  });
  return { server, state };
}

function request(port, options = {}) {
  const method = options.method || 'GET';
  const pathname = options.path || '/';
  const headers = { host: '127.0.0.1:' + port, ...(options.headers || {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function startProxy(options = {}) {
  const upstream = createUpstream();
  upstream.server.listen(0, '127.0.0.1');
  await once(upstream.server, 'listening');
  const supervisor = {
    state: options.state || 'ready',
    tokenValue: options.token === undefined ? 'good-token' : options.token,
    status() { return { state: this.state, tokenCaptured: this.tokenValue !== null }; },
    token() { return this.tokenValue; },
  };
  const logs = [];
  const proxy = createProxy({
    listenHost: '127.0.0.1',
    webPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.server.address().port,
    supervisor,
    trustedHosts: parseTrustedHosts(options.trustedHosts || 'dsh.test trusted.example:8443'),
    logger: line => logs.push(line),
    exchangeWindowMs: options.exchangeWindowMs,
    exchangeBudget: options.exchangeBudget,
  });
  await proxy.listen();
  const port = proxy.server.address().port;
  const close = async () => {
    await proxy.close();
    upstream.server.closeAllConnections();
    upstream.server.close();
  };
  return { proxy, upstream, supervisor, port, logs, close };
}

test('unit: authority normalization, trusted hosts, and loopback rules', () => {
  assert.equal(normalizeAuthority('DSH.TEST:8443'), 'dsh.test:8443');
  assert.equal(normalizeAuthority('dsh.test.'), 'dsh.test.');
  assert.equal(normalizeAuthority('bad host'), null);
  assert.equal(normalizeAuthority(''), null);
  const trusted = parseTrustedHosts('dsh.test, trusted.example:8443, [::1]:9000');
  assert.equal(isTrustedHost('127.1.2.3:3080', trusted), true);
  assert.equal(isTrustedHost('[::1]:3080', trusted), true);
  assert.equal(isTrustedHost('localhost:3080', trusted), false);
  assert.equal(isTrustedHost('dsh.test:1234', trusted), true);
  assert.equal(isTrustedHost('trusted.example:8443', trusted), true);
  assert.equal(isTrustedHost('trusted.example:8444', trusted), false);
  assert.equal(isTrustedHost('[::1]:9000', trusted), true);
  assert.equal(dshCookieName('dsh.test:8443'), dshCookieName('dsh.test:8443'));
});

test('transparent forwarding preserves method, body, status, and headers', async t => {
  const { port, close, logs } = await startProxy();
  t.after(close);
  const response = await request(port, {
    method: 'POST',
    path: '/echo',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('payload-bytes'),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-echo'], 'yes');
  assert.equal(response.body, 'payload-bytes');
  assert.equal(logs.some(line => line.includes('good-token')), false, 'proxy logs must never contain the launch token');
});

test('a fresh GET / exchanges once with 303 + Set-Cookie, then the browser cookie gets 200', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const fresh = await request(port);
  assert.equal(fresh.status, 303);
  assert.equal(fresh.headers.location, './');
  assert.ok(fresh.headers['set-cookie'], 'the exchange 303 must carry Set-Cookie');
  const cookiePair = fresh.headers['set-cookie'][0].split(';')[0];
  const replay = await request(port, { headers: { cookie: cookiePair } });
  assert.equal(replay.status, 200);
  assert.match(replay.body, /INDEX/);
  const api = await request(port, { path: '/api/thing', headers: { cookie: cookiePair } });
  assert.equal(api.status, 200);
  assert.deepEqual(JSON.parse(api.body), { ok: true });
});

test('manual ?token= always wins and is forwarded verbatim, even while starting', async t => {
  const { port, close, supervisor } = await startProxy({ state: 'starting', token: null });
  t.after(close);
  const response = await request(port, { path: '/?token=good-token' });
  assert.equal(response.status, 303, 'manual token must go straight upstream');
  assert.ok(response.headers['set-cookie']);
  assert.equal(supervisor.token(), null);
});

test('the Host gate rejects localhost and undeclared authorities, ignores X-Forwarded-Host', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const localhost = await request(port, { headers: { host: 'localhost:' + port } });
  assert.equal(localhost.status, 403);
  assert.match(localhost.body, /not trusted/);
  const undeclared = await request(port, { headers: { host: 'evil.example:' + port } });
  assert.equal(undeclared.status, 403);
  const forwarded = await request(port, {
    headers: { host: '127.0.0.1:' + port, 'x-forwarded-host': 'evil.example' },
  });
  assert.notEqual(forwarded.status, 403, 'X-Forwarded-Host must not influence the gate');
  const declared = await request(port, { headers: { host: 'dsh.test' } });
  assert.equal(declared.status, 303);
});

test('starting serves a 200 refresh page to navigation and JSON to /api', async t => {
  const { port, close } = await startProxy({ state: 'starting', token: null });
  t.after(close);
  const navigation = await request(port, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
  });
  assert.equal(navigation.status, 200);
  assert.equal(navigation.headers['retry-after'], '5');
  assert.match(navigation.body, /http-equiv="refresh" content="5"/);
  const api = await request(port, { path: '/api/thing', headers: { accept: 'application/json' } });
  assert.equal(api.status, 503);
  assert.equal(api.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(api.body), { error: { code: 'starting' } });
  const text = await request(port, { path: '/status', headers: { accept: '*/*' } });
  assert.equal(text.status, 503);
  assert.match(text.body, /starting/);
});

test('token-timeout is a static 503 page without a refresh', async t => {
  const { port, close } = await startProxy({ state: 'token-timeout', token: null });
  t.after(close);
  const response = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(response.status, 503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /http-equiv="refresh"/);
  assert.match(response.body, /Launch token is not available/);
});

test('the exchange budget is two per window and gates only the exchange', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const first = await request(port);
  const second = await request(port);
  assert.equal(first.status, 303);
  assert.equal(second.status, 303);
  const limited = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(limited.status, 503);
  assert.equal(limited.headers['retry-after'], '10');
  assert.match(limited.body, /Too many automatic login attempts/);
  const plain = await request(port, { headers: { accept: 'application/json' } });
  assert.equal(plain.status, 503, 'a non-navigation GET gets the plain-text budget failure');
  const api = await request(port, { path: '/api/thing', headers: { accept: 'application/json' } });
  assert.equal(api.status, 401, 'the budget must not gate non-index forwarding');
  const cookiePair = first.headers['set-cookie'][0].split(';')[0];
  const replay = await request(port, { headers: { cookie: cookiePair } });
  assert.equal(replay.status, 200, 'the budget must not gate cookie-authenticated forwarding');
});

test('a rejected launch token becomes the exchange-401 surface', async t => {
  const { port, close } = await startProxy({ token: 'wrong-token' });
  t.after(close);
  const response = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(response.status, 503);
  assert.match(response.body, /Launch token was rejected/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('a stale browser cookie is silently repaired once the token is available', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const authorityCookie = dshCookieName('127.0.0.1:' + port) + '=v1.stale';
  const repaired = await request(port, { headers: { cookie: authorityCookie } });
  assert.equal(repaired.status, 303, 'stale cookie + upstream 401 + token -> exchange 303');
  const cookiePair = repaired.headers['set-cookie'][0].split(';')[0];
  const replay = await request(port, { headers: { cookie: cookiePair } });
  assert.equal(replay.status, 200);
});

test('a cached cookie is injected only when the browser has none and the token is unavailable', async t => {
  const { port, close, upstream, supervisor } = await startProxy();
  t.after(close);
  const fresh = await request(port);
  assert.equal(fresh.status, 303);
  supervisor.state = 'starting';
  supervisor.tokenValue = null;
  const injected = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(injected.status, 200);
  assert.match(injected.body, /INDEX/);

  upstream.state.rejectInjectedCookie = true;
  const rejected = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(rejected.status, 503);
  assert.match(rejected.body, /No usable session/);
  assert.equal(rejected.headers['cache-control'], 'no-store');
});

test('a v2 /connect cookie is not a browser session', async t => {
  const { port, close } = await startProxy({ state: 'starting', token: null });
  t.after(close);
  const v2 = dshCookieName('127.0.0.1:' + port) + '=v2.api-token';
  const response = await request(port, {
    headers: { cookie: v2, accept: 'text/html', 'sec-fetch-dest': 'document' },
  });
  assert.equal(response.status, 200, 'starting navigation page, not a forwarded index');
  assert.match(response.body, /DSH is starting/);
});

test('a foreign authority cookie does not suppress fallback injection', async t => {
  const { port, close, supervisor } = await startProxy();
  t.after(close);
  const fresh = await request(port);
  assert.equal(fresh.status, 303);
  supervisor.state = 'starting';
  supervisor.tokenValue = null;
  const foreign = dshCookieName('other.example:8443') + '=v1.foreign';
  const response = await request(port, {
    headers: { cookie: foreign, accept: 'text/html', 'sec-fetch-dest': 'document' },
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /INDEX/);
});

test('SSE is streamed without buffering', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const firstChunk = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/sse', headers: { host: '127.0.0.1:' + port } }, res => {
      res.setEncoding('utf8');
      res.once('data', chunk => resolve({ chunk, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(firstChunk.chunk, /data: first/);
  assert.equal(firstChunk.headers['content-type'], 'text/event-stream');
});

test('a WebSocket upgrade becomes a raw bidirectional pipe', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const handshake = await new Promise(resolve => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
  });
  assert.match(handshake, /^HTTP\/1\.1 101/);
  const echoed = await new Promise(resolve => {
    socket.once('data', chunk => resolve(chunk.toString('utf8')));
    socket.write('ping');
  });
  assert.equal(echoed, 'ping');
  socket.destroy();
});

test('a WS upgrade against the Host gate is rejected with 403', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET /ws HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const response = await new Promise(resolve => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('</html>')) resolve(buffer);
    });
  });
  assert.match(response, /^HTTP\/1\.1 403/);
});

test('a WS upgrade without a session returns a 503 JSON handshake failure', async t => {
  const { port, close } = await startProxy({ state: 'token-timeout', token: null });
  t.after(close);
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const response = await new Promise(resolve => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) resolve(buffer);
    });
  });
  assert.match(response, /^HTTP\/1\.1 503/);
  assert.match(response, /application\/json/);
  assert.match(response, /token-timeout/);
});

test('cookie caches are isolated per authority', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const first = await request(port);
  assert.equal(first.status, 303);
  const firstCookie = first.headers['set-cookie'][0].split(';')[0];
  const otherAuthority = await request(port, { headers: { host: 'dsh.test' } });
  assert.equal(otherAuthority.status, 303, 'a second authority gets its own exchange');
  const otherCookie = otherAuthority.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(firstCookie, otherCookie);
  const firstReplay = await request(port, { headers: { cookie: firstCookie } });
  assert.equal(firstReplay.status, 200);
  const crossAuthority = await request(port, { headers: { host: 'dsh.test', cookie: firstCookie } });
  assert.equal(crossAuthority.status, 303, 'another authority\'s cookie must not authenticate this one');
});

test('a 1 MB request body streams through unchanged', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const body = Buffer.alloc(1024 * 1024, 7);
  const response = await request(port, { method: 'POST', path: '/echo', body });
  assert.equal(response.status, 200);
  assert.equal(Buffer.byteLength(response.body), body.length);
  assert.equal(response.body, body.toString('utf8'));
});

test('multiple Set-Cookie headers on the exchange 303 pass through verbatim', async t => {
  const { port, close, upstream } = await startProxy();
  t.after(close);
  upstream.state.multiCookie = true;
  const response = await request(port);
  assert.equal(response.status, 303);
  assert.equal(response.headers['set-cookie'].length, 2);
  assert.match(response.headers['set-cookie'][0], /^dsh-auth-/);
  assert.match(response.headers['set-cookie'][1], /^other-cookie=/);
});

test('gzip responses pass through without decoding or re-encoding', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const response = await request(port, { path: '/gzip', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.body, zlib.gzipSync(Buffer.from('gzip-payload')).toString('utf8'));
});

test('a connect failure is a 502, except for navigation while starting', async t => {
  const upstream = http.createServer();
  const proxy = createProxy({
    listenHost: '127.0.0.1',
    webPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: 1,
    supervisor: { status() { return { state: 'ready' }; }, token() { return 'good-token'; } },
    trustedHosts: [],
    logger: () => {},
  });
  await proxy.listen();
  t.after(async () => { await proxy.close(); upstream.close(); });
  const port = proxy.server.address().port;
  const failed = await request(port, { path: '/echo', method: 'POST', body: 'x' });
  assert.equal(failed.status, 502);

  const startingProxy = createProxy({
    listenHost: '127.0.0.1',
    webPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: 1,
    supervisor: { status() { return { state: 'starting' }; }, token() { return null; } },
    trustedHosts: [],
    logger: () => {},
  });
  await startingProxy.listen();
  t.after(async () => { await startingProxy.close(); });
  const startingPort = startingProxy.server.address().port;
  const navigation = await request(startingPort, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
  assert.equal(navigation.status, 200, 'starting navigation falls back to the state page, not a bare 502');
  const api = await request(startingPort, { path: '/api/thing', headers: { accept: 'application/json' } });
  assert.equal(api.status, 503);
});

test('GET /?foo=1 keeps the query and cookies reach /api', async t => {
  const { port, close } = await startProxy();
  t.after(close);
  const fresh = await request(port, { path: '/?foo=1' });
  assert.equal(fresh.status, 303);
  const cookiePair = fresh.headers['set-cookie'][0].split(';')[0];
  const replay = await request(port, { path: '/?foo=1', headers: { cookie: cookiePair } });
  assert.equal(replay.status, 200);
  assert.match(replay.body, /\?foo=1/);
});
