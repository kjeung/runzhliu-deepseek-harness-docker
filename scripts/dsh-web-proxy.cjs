#!/usr/bin/env node
'use strict';

// DSH transparent proxy (spec #15; decisions #4, #8, #9; supervisor #13).
//
// The proxy shares the supervisor's process in web mode. It listens on one
// concrete container address, forwards HTTP/1.1 and WebSocket traffic to DSH's
// loopback listener, and makes exactly four semantic deviations from a
// byte-transparent pipe:
//
//   1. the Host gate (all paths, including WS upgrades);
//   2. the launch-token exchange response (303 + Set-Cookie) is returned to
//      the browser verbatim;
//   3. a cached session cookie may be injected as a fallback when the browser
//      has no DSH cookie for this authority and the token is unavailable;
//   4. failure responses replace the upstream response for the documented
//      failure faces.
//
// Everything else is transparent: bodies stream unchanged, no buffering, no
// compression changes, no header injection (no X-Forwarded-*), the browser's
// Host is forwarded verbatim, SSE is never buffered, and WS upgrades become a
// raw bidirectional pipe. Proxy logs and pages never contain the launch token.

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

const LAUNCH_TOKEN_PARAM = 'token';
const EXCHANGE_WINDOW_MS = 10 * 1000;
const EXCHANGE_BUDGET = 2;
const EXCHANGE_TIMEOUT_MS = 5 * 1000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 5 * 1000;
const NORMAL_REQUEST_TIMEOUT_MS = 300 * 1000;
const STARTING_REFRESH_MS = 5 * 1000;
const STATE_LOG_DEDUPE_MS = 5 * 60 * 1000;
const README_SECURITY_ANCHOR = '#安全模型--security-model';
const DEFAULT_WEB_PORT = 3080;

// ---------------------------------------------------------------------------
// Host parsing and the trusted-host gate
// ---------------------------------------------------------------------------

// DSH computes its cookie authority with new URL('http://' + Host).host
// (WHATWG parsing). The proxy uses the same normalization so the cookie name
// it expects is exactly the one DSH mints.
function normalizeAuthority(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  try {
    const url = new URL('http://' + hostHeader);
    return url.host ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function splitAuthority(authority) {
  try {
    const url = new URL('http://' + authority);
    const host = url.hostname.toLowerCase();
    return { host, port: url.port ? url.port : null, ipv6: host.startsWith('[') };
  } catch {
    return null;
  }
}

// Trusted-host entries are bare host[:port] values separated by spaces and/or
// commas. A portless entry matches any port; an explicit port (including :80
// and :443) is matched literally instead of being swallowed by WHATWG
// default-port normalization.
function parseTrustedHosts(value) {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      let host = entry;
      let port = null;
      const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
      if (bracketed) {
        host = bracketed[1];
        port = bracketed[2] ?? null;
      } else {
        const match = /^([^:]+)(?::(\d+))?$/.exec(entry);
        if (match) {
          host = match[1];
          port = match[2] ?? null;
        }
      }
      return { host: host.toLowerCase().replace(/\.$/, ''), port };
    });
}

function isLoopbackAuthority(authority) {
  const parsed = splitAuthority(authority);
  if (!parsed) return false;
  if (parsed.ipv6) return parsed.host === '[::1]';
  const octets = parsed.host.split('.');
  if (octets.length !== 4) return false;
  if (octets[0] !== '127') return false;
  return octets.every(octet => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255);
}

function isTrustedHost(authority, trustedHosts) {
  const parsed = splitAuthority(authority);
  if (!parsed) return false;
  if (isLoopbackAuthority(authority)) return true;
  const host = parsed.host.replace(/\.$/, '');
  return trustedHosts.some(entry => {
    if (entry.host !== host) return false;
    if (entry.port === null) return true;
    return entry.port === parsed.port;
  });
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

// The v1 browser cookie name is exactly dsh-auth-<base64url(sha256(authority))>
// per the #4 contract. A value-prefix check keeps a future payload shape
// accepted without renaming, while /connect's v2 API cookie is explicitly not
// a browser session.
function dshCookieName(authority) {
  const digest = crypto.createHash('sha256').update(authority).digest('base64url');
  return 'dsh-auth-' + digest;
}

function parseCookieHeader(header) {
  if (!header) return [];
  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf('=');
      if (index === -1) return { name: part, value: '' };
      return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
    });
}

function browserHasV1Cookie(cookieHeader, authority) {
  const expected = dshCookieName(authority);
  return parseCookieHeader(cookieHeader).some(cookie => {
    // Exactly the authority-bound name (so a foreign authority's cookie never
    // suppresses fallback injection) and never the /connect v2 API payload.
    return cookie.name === expected && cookie.value !== '' && !cookie.value.startsWith('v2.');
  });
}

function parseSetCookie(headerValue) {
  const pair = headerValue.split(';')[0];
  const index = pair.indexOf('=');
  if (index === -1) return null;
  const name = pair.slice(0, index).trim();
  const value = pair.slice(index + 1).trim();
  if (!name) return null;
  let expiresAt = null;
  for (const attribute of headerValue.split(';').slice(1)) {
    const eq = attribute.indexOf('=');
    const key = (eq === -1 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
    const rawValue = eq === -1 ? '' : attribute.slice(eq + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(rawValue);
      if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'expires' && expiresAt === null) {
      const parsed = Date.parse(rawValue);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  return { name, value, expiresAt };
}

// ---------------------------------------------------------------------------
// Listener address selection and the fixed Web port
// ---------------------------------------------------------------------------

function selectAddress(interfaces, requestedInterface) {
  const entries = Object.entries(interfaces).filter(([name]) => !requestedInterface || name === requestedInterface);
  const addresses = entries.flatMap(([, rows]) => (rows || []).filter(row => !row.internal));
  const ipv4 = addresses.filter(row => row.family === 'IPv4' && net.isIP(row.address) === 4 && !row.address.startsWith('127.') && row.address !== '0.0.0.0');
  const ipv6 = addresses.filter(row => row.family === 'IPv6' && net.isIP(row.address) === 6 && row.address !== '::' && row.address !== '::1' && !row.address.toLowerCase().startsWith('fe80:'));
  const candidates = [...new Set((ipv4.length ? ipv4 : ipv6).map(row => row.address))];
  if (candidates.length !== 1) {
    throw new Error('expected one concrete container address; set DSH_WEB_RELAY_INTERFACE to a single container network interface (host networking is not supported)');
  }
  return candidates[0];
}

function webPort(args) {
  let port = String(DEFAULT_WEB_PORT);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = args[++i];
    else if (args[i].startsWith('--port=')) port = args[i].slice(7);
    else if (args[i] === '--') break;
  }
  if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('container Web proxy requires a fixed --port between 1 and 65535');
  }
  return Number(port);
}

// ---------------------------------------------------------------------------
// Failure surfaces (spec #8 + #15)
// ---------------------------------------------------------------------------

function isDocumentNavigation(req) {
  if (req.method !== 'GET') return false;
  const dest = req.headers['sec-fetch-dest'];
  if (dest && dest !== 'document') return false;
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}

function classifyRequest(req) {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'json';
  if (isDocumentNavigation(req)) return 'html';
  return 'text';
}

const FAILURE_COPY = {
  starting: {
    title: 'DSH is starting',
    body: 'DeepSeek Harness is still starting. This page refreshes automatically; no manual retry is needed.',
  },
  'token-timeout': {
    title: 'Launch token is not available',
    body: 'Harness has not printed its launch token within 120 seconds. Inspect the container log for the startup error, or open the URL printed after dsh web: in that log with its ?token= query.',
  },
  'exchange-401': {
    title: 'Launch token was rejected',
    body: 'DSH rejected the launch token during the automatic exchange. Reopen the URL printed after dsh web: in the container log with its ?token= query, or check the log for a rotated token.',
  },
  'session-expired': {
    title: 'Session expired',
    body: 'The browser session cookie was rejected and no launch token is available. Reopen the URL printed after dsh web: in the container log with its ?token= query.',
  },
  'exchange-budget': {
    title: 'Too many automatic login attempts',
    body: 'This client exceeded the automatic-login budget. Wait about 10 seconds and reload this page, or open the URL printed after dsh web: in the container log with its ?token= query.',
  },
  'session-unavailable': {
    title: 'No usable session',
    body: 'The cached session was rejected by DSH and no launch token is available. Reopen the URL printed after dsh web: in the container log with its ?token= query.',
  },
  'exchange-failed': {
    title: 'Automatic login failed',
    body: 'The automatic launch-token exchange failed. Open the URL printed after dsh web: in the container log with its ?token= query.',
  },
};

function failureStatus(kind, code) {
  if (code === 'starting' && kind === 'html') return 200;
  return 503;
}

function renderFailureHtml(code) {
  const copy = FAILURE_COPY[code] ?? {
    title: 'Harness is unavailable',
    body: 'The automatic login path failed. Open the URL printed after dsh web: in the container log with its ?token= query.',
  };
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  ];
  if (code === 'starting') {
    lines.push('  <meta http-equiv="refresh" content="' + String(STARTING_REFRESH_MS / 1000) + '">');
  }
  lines.push(
    '  <title>' + escapeHtml(copy.title) + '</title>',
    '  <style>',
    '    body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 42rem; line-height: 1.5; color: #1f2328; }',
    '    code { background: #f6f8fa; padding: .15rem .3rem; border-radius: 4px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>' + escapeHtml(copy.title) + '</h1>',
    '  <p>' + escapeHtml(copy.body) + '</p>',
  );
  if (code === 'exchange-budget') {
    lines.push('  <p><a href="./">Retry now</a> (a reload before the window expires still fails).</p>');
  }
  lines.push(
    '  <p>Diagnostics: <code>docker logs deepseek-harness 2&gt;&amp;1 | grep \'dsh web:\'</code></p>',
    '  <p>Manual fallback: open the URL printed after <code>dsh web:</code> in that log, including its <code>?token=</code> query.</p>',
    '</body>',
    '</html>',
  );
  return lines.join('\n') + '\n';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderForbiddenHtml(host, trustedHosts) {
  const allowed = trustedHosts.map(entry => (entry.port ? entry.host + ':' + entry.port : entry.host));
  const allowedList = allowed.length ? allowed.map(escapeHtml).join(', ') : '(loopback only)';
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Host not allowed</title>',
    '  <style>',
    '    body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 42rem; line-height: 1.5; color: #1f2328; }',
    '    code { background: #f6f8fa; padding: .15rem .3rem; border-radius: 4px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>Host not allowed</h1>',
    '  <p>The requested Host <code>' + escapeHtml(host) + '</code> is not trusted by this container.</p>',
    '  <p>Allowed: <code>' + allowedList + '</code> plus loopback (<code>127.0.0.0/8</code>, <code>[::1]</code>). <code>localhost</code> is intentionally not loopback.</p>',
    '  <p>Add the exact authority to <code>DSH_TRUSTED_HOSTS</code> and restart the container. See the README security model.</p>',
    '</body>',
    '</html>',
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

function createProxy(options = {}) {
  const supervisor = options.supervisor;
  if (!supervisor || typeof supervisor.status !== 'function' || typeof supervisor.token !== 'function') {
    throw new Error('proxy requires a supervisor-like { status(), token() } dependency');
  }
  const listenHost = options.listenHost;
  const listenPort = options.webPort ?? DEFAULT_WEB_PORT;
  const upstreamHost = options.upstreamHost ?? '127.0.0.1';
  const upstreamPort = options.upstreamPort ?? listenPort;
  const trustedHosts = options.trustedHosts ?? parseTrustedHosts(process.env.DSH_TRUSTED_HOSTS);
  const logger = options.logger ?? (line => process.stderr.write(line + '\n'));
  const now = options.now ?? Date.now;
  const exchangeWindowMs = options.exchangeWindowMs ?? EXCHANGE_WINDOW_MS;
  const exchangeBudget = options.exchangeBudget ?? EXCHANGE_BUDGET;
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? EXCHANGE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? NORMAL_REQUEST_TIMEOUT_MS;

  const cookieCache = new Map(); // authority -> { name, value, expiresAt, suspended }
  const budgets = new Map(); // peer|authority -> [timestamps]
  const stateLog = new Map(); // code -> last emitted timestamp

  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set();

  function logState(code, host, extra = {}) {
    const previous = stateLog.get(code) ?? 0;
    if (now() - previous < STATE_LOG_DEDUPE_MS) return;
    stateLog.set(code, now());
    logger(JSON.stringify({ event: 'proxy-state', code, host, ...extra }));
  }

  function sendFailure(req, res, code, extra = {}) {
    const kind = classifyRequest(req);
    const status = failureStatus(kind, code);
    const headers = { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' };
    if (code === 'starting') headers['retry-after'] = String(STARTING_REFRESH_MS / 1000);
    if (code === 'exchange-budget') headers['retry-after'] = String(exchangeWindowMs / 1000);
    if (kind === 'html') {
      headers['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(status, headers);
      res.end(renderFailureHtml(code));
    } else if (kind === 'json') {
      headers['content-type'] = 'application/json; charset=utf-8';
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: { code } }));
    } else {
      res.writeHead(status, headers);
      res.end('DSH proxy: ' + code + '\n');
    }
    logState(code, extra.authority ?? '', { status });
  }

  function sendForbidden(req, res, host) {
    const headers = { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' };
    res.writeHead(403, headers);
    res.end(renderForbiddenHtml(host, trustedHosts));
    logState('host-forbidden', host, { status: 403 });
  }

  function cacheGet(authority) {
    const entry = cookieCache.get(authority);
    if (!entry) return null;
    if (entry.suspended) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) return null;
    return entry;
  }

  function cacheStore(authority, setCookieHeaders) {
    for (const header of setCookieHeaders ?? []) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      if (!parsed.name.startsWith('dsh-auth-')) continue;
      const existing = cookieCache.get(authority);
      cookieCache.set(authority, {
        name: parsed.name,
        value: parsed.value,
        expiresAt: parsed.expiresAt,
        suspended: existing ? existing.suspended : false,
      });
    }
  }

  function cacheSuspend(authority) {
    const entry = cookieCache.get(authority);
    if (!entry) return;
    entry.suspended = true;
    cookieCache.set(authority, entry);
  }

  function budgetAllows(peer, authority) {
    const key = peer + '|' + authority;
    const cutoff = now() - exchangeWindowMs;
    const recent = (budgets.get(key) ?? []).filter(timestamp => timestamp > cutoff);
    if (recent.length >= exchangeBudget) {
      budgets.set(key, recent);
      return false;
    }
    recent.push(now());
    budgets.set(key, recent);
    return true;
  }

  function mergeCookie(header, entry) {
    const pair = entry.name + '=' + entry.value;
    if (!header) return pair;
    return header + '; ' + pair;
  }

  function canExchange(req) {
    const url = new URL(req.url || '/', 'http://placeholder');
    return req.method === 'GET'
      && url.pathname === '/'
      && !url.searchParams.has(LAUNCH_TOKEN_PARAM)
      && supervisor.token() !== null;
  }

  function exchange(req, res, authority) {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!budgetAllows(peer, authority)) {
      return sendFailure(req, res, 'exchange-budget', { authority });
    }
    const token = supervisor.token();
    if (token === null) return sendFailure(req, res, 'token-timeout', { authority });
    const target = new URL(req.url || '/', 'http://' + authority);
    target.searchParams.set(LAUNCH_TOKEN_PARAM, token);
    const headers = {
      host: authority,
      cookie: req.headers.cookie ?? '',
      accept: req.headers.accept ?? '*/*',
    };
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: 'GET',
      path: target.pathname + target.search,
      headers,
      agent: false,
    });
    upstream.setTimeout(exchangeTimeoutMs, () => upstream.destroy(new Error('exchange timeout')));
    upstream.on('error', () => sendFailure(req, res, 'exchange-failed', { authority }));
    upstream.on('response', upstreamRes => {
      upstreamRes.on('error', () => res.destroy());
      if (upstreamRes.statusCode === 303) {
        cacheStore(authority, upstreamRes.headers['set-cookie']);
        res.writeHead(303, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }
      const status = upstreamRes.statusCode;
      upstreamRes.resume();
      upstreamRes.on('end', () => {
        if (status === 401) {
          const hasCookie = browserHasV1Cookie(req.headers.cookie, authority);
          sendFailure(req, res, hasCookie ? 'session-expired' : 'exchange-401', { authority });
        } else {
          sendFailure(req, res, 'exchange-failed', { authority });
        }
      });
    });
    upstream.end();
  }

  function forward(req, res, authority, opts = {}) {
    const headers = { ...req.headers };
    if (opts.injectCookie) headers.cookie = mergeCookie(req.headers.cookie, opts.injectCookie);
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
      agent,
    });
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('upstream connect timeout')));
    upstream.on('error', error => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const state = supervisor.status().state;
      const document = isDocumentNavigation(req);
      if (document && (state === 'starting' || state === 'token-timeout')) {
        sendFailure(req, res, state, { authority });
      } else {
        res.writeHead(502, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
        res.end('DSH proxy: upstream connection failed\n');
      }
    });
    upstream.on('response', upstreamRes => {
      const setCookie = upstreamRes.headers['set-cookie'];
      const isSse = String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream');
      if (isSse) upstream.setTimeout(0);
      else upstream.setTimeout(requestTimeoutMs);
      if (opts.exchangeOn401 && upstreamRes.statusCode === 401 && !setCookie && canExchange(req)) {
        upstreamRes.resume();
        upstreamRes.on('end', () => exchange(req, res, authority));
        return;
      }
      if (opts.injectCookie && upstreamRes.statusCode === 401) {
        upstreamRes.resume();
        upstreamRes.on('end', () => {
          cacheSuspend(authority);
          sendFailure(req, res, 'session-unavailable', { authority });
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });
    req.on('error', () => upstream.destroy());
    if (req.method === 'GET' || req.method === 'HEAD') {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  }

  function handleRequest(req, res) {
    const hostHeader = req.headers.host ?? '';
    const authority = normalizeAuthority(hostHeader);
    if (!authority || !isTrustedHost(authority, trustedHosts)) {
      return sendForbidden(req, res, hostHeader);
    }
    const url = new URL(req.url || '/', 'http://' + authority);
    const hasToken = url.searchParams.has(LAUNCH_TOKEN_PARAM);
    const hasCookie = browserHasV1Cookie(req.headers.cookie, authority);
    const state = supervisor.status().state;

    if (hasToken) return forward(req, res, authority);

    if (hasCookie) {
      return forward(req, res, authority, { exchangeOn401: supervisor.token() !== null });
    }

    if (state === 'starting' || state === 'token-timeout') {
      const cached = cacheGet(authority);
      if (cached) return forward(req, res, authority, { injectCookie: cached });
      return sendFailure(req, res, state, { authority });
    }

    const isIndex = url.pathname === '/';
    return forward(req, res, authority, { exchangeOn401: isIndex });
  }

  function rawFailure(socket, code) {
    const body = JSON.stringify({ error: { code } }) + '\n';
    socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: ' + Buffer.byteLength(body) + '\r\nconnection: close\r\n\r\n');
    socket.end(body);
    logState(code, '', { status: 503 });
  }

  function writeRawResponse(socket, statusCode, statusMessage, headers, body) {
    const lines = ['HTTP/1.1 ' + statusCode + ' ' + statusMessage];
    for (let i = 0; i < headers.length; i += 2) {
      lines.push(headers[i] + ': ' + headers[i + 1]);
    }
    lines.push('content-length: ' + Buffer.byteLength(body), 'connection: close', '', body);
    socket.end(lines.join('\r\n'));
  }

  function handleUpgrade(req, socket, head) {
    const hostHeader = req.headers.host ?? '';
    const authority = normalizeAuthority(hostHeader);
    if (!authority || !isTrustedHost(authority, trustedHosts)) {
      writeRawResponse(socket, 403, 'Forbidden', ['content-type', 'text/html; charset=utf-8', 'cache-control', 'no-store'], renderForbiddenHtml(hostHeader, trustedHosts));
      return;
    }
    const state = supervisor.status().state;
    const hasCookie = browserHasV1Cookie(req.headers.cookie, authority);
    const cached = state === 'starting' || state === 'token-timeout' ? cacheGet(authority) : null;
    if (!hasCookie && !cached && state !== 'ready') {
      return rawFailure(socket, state);
    }
    const headers = { ...req.headers };
    if (cached) headers.cookie = mergeCookie(req.headers.cookie, cached);
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    });
    upstream.setTimeout(0);
    upstream.on('error', () => rawFailure(socket, 'upstream-unavailable'));
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write('HTTP/1.1 ' + upstreamRes.statusCode + ' ' + upstreamRes.statusMessage + '\r\n');
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        socket.write(upstreamRes.rawHeaders[i] + ': ' + upstreamRes.rawHeaders[i + 1] + '\r\n');
      }
      socket.write('\r\n');
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
      const teardown = () => { socket.destroy(); upstreamSocket.destroy(); };
      socket.on('error', teardown);
      upstreamSocket.on('error', teardown);
      socket.on('close', teardown);
      upstreamSocket.on('close', teardown);
    });
    upstream.on('response', upstreamRes => {
      socket.write('HTTP/1.1 ' + upstreamRes.statusCode + ' ' + upstreamRes.statusMessage + '\r\n');
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        socket.write(upstreamRes.rawHeaders[i] + ': ' + upstreamRes.rawHeaders[i + 1] + '\r\n');
      }
      socket.write('\r\n');
      upstreamRes.pipe(socket);
    });
    upstream.end();
  }

  const server = http.createServer(handleRequest);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', handleUpgrade);
  server.on('checkContinue', (req, res) => {
    res.writeContinue();
    handleRequest(req, res);
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: listenHost, port: listenPort }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = {
  DEFAULT_WEB_PORT,
  EXCHANGE_BUDGET,
  EXCHANGE_WINDOW_MS,
  browserHasV1Cookie,
  createProxy,
  dshCookieName,
  isTrustedHost,
  normalizeAuthority,
  parseTrustedHosts,
  selectAddress,
  webPort,
};
