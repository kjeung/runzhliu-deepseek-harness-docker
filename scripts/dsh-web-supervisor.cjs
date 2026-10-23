#!/usr/bin/env node
'use strict';

// DSH supervisor: the single owner of the `dsh` child in web containers
// (decision A, wayfinder #12; spec #13; ADR-0001).
//
// Responsibilities (bootstrap layer only — proxy HTTP semantics are a later
// spec):
//   - spawn `dsh` and mirror its stdout/stderr into the container log
//     line-by-line: verbatim, unprefixed, per-stream ordered, tail flushed
//     on close;
//   - capture the launch token from the `dsh web:` line, held in memory
//     bound to { pid, startedAt }; the process exit invalidates it;
//   - expose a queryable state machine: starting -> ready | token-timeout,
//     then exited, with an explicit stop() reset for admin version switches;
//   - replace the retired raw TCP relay: forward one concrete container
//     address to DSH's loopback listener (byte-only, no HTTP interpretation);
//   - propagate the child's exit code and forward INT/TERM/HUP down the
//     chain tini -> entrypoint -> supervisor -> dsh, each hop waiting.
//
// Diagnostics never contain the token or the launch line. The env seams
// below exist for scripts/dsh-web-supervisor.test.cjs and the container
// smoke on purpose:
//   DSH_WEB_SUPERVISOR_CHILD           executable that replaces /usr/local/bin/dsh
//   DSH_WEB_SUPERVISOR_LISTEN_ADDRESS  forwarder bind host (default: fail-closed
//                                      selectAddress())
//   DSH_WEB_SUPERVISOR_NO_LISTENER=1   skip the forwarder entirely
//   DSH_WEB_RELAY_INTERFACE            historical fail-closed interface knob

const childProcess = require('node:child_process');
const net = require('node:net');
const os = require('node:os');

const LAUNCH_LINE_PREFIX = 'dsh web: ';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TOKEN_TIMEOUT_MS = 120 * 1000;
const DEFAULT_COMMAND = '/usr/local/bin/dsh';
const SIGNAL_EXIT_NUMBERS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

// Parse the first whitespace-delimited candidate of a `dsh web:` line as a
// URL. Exactly one `token` query parameter of 43 base64url characters is
// required; everything after the first whitespace (including the obsolete
// ` (LAN: …)` suffix of 0.1.2-alpha.2–0.2.1-alpha.1) is ignored. A line
// without a URL (the browser-handoff note or the stderr warning) or without
// a usable token never echoes its content into diagnostics.
function extractLaunchToken(line) {
  if (!line.startsWith(LAUNCH_LINE_PREFIX)) return null;
  const candidate = line.slice(LAUNCH_LINE_PREFIX.length).split(/\s+/)[0];
  if (!candidate) return null;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const tokens = url.searchParams.getAll('token');
  if (tokens.length !== 1 || !TOKEN_PATTERN.test(tokens[0])) return null;
  return tokens[0];
}

// Select one concrete non-loopback address so Docker/Podman port publication
// works without a wildcard listener. Ambiguous multi-interface setups fail
// closed instead of guessing. DSH_WEB_RELAY_INTERFACE keeps its historical
// name: the knob selects the interface, not the forwarder implementation.
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

// The container Web listener must be a fixed port so the published port and
// the probes stay meaningful; --port 0 is rejected on purpose.
function webPort(args) {
  let port = '3080';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = args[++i];
    else if (args[i].startsWith('--port=')) port = args[i].slice(7);
    else if (args[i] === '--') break;
  }
  if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('container Web supervisor requires a fixed --port between 1 and 65535');
  }
  return Number(port);
}

// Raw TCP forwarder (the retired relay's behavior): one concrete container
// address to DSH's loopback listener. Bytes are piped untouched, half-close
// is preserved, and either side closing destroys the pair.
function createForwarder({ host, port, targetHost = '127.0.0.1', targetPort }) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, client => {
    const upstream = net.connect({ host: targetHost, port: targetPort, allowHalfOpen: true });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    const destroyPair = () => { client.destroy(); upstream.destroy(); };
    client.on('error', destroyPair);
    upstream.on('error', destroyPair);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port }, () => { server.off('error', reject); resolve(); });
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

// Mirror one child stream into `sink` line by line: each completed line is
// written immediately (no prefix, no buffering); a trailing partial line is
// flushed verbatim when the stream closes. Ordering is per stream only.
function mirrorStream(stream, sink, onLine) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      sink.write(line + '\n');
      if (onLine) onLine(line);
    }
  });
  stream.on('close', () => {
    if (pending) sink.write(pending);
    pending = '';
  });
}

function mapExitCode(code, signal) {
  if (code !== null) return code;
  return 128 + (SIGNAL_EXIT_NUMBERS[signal] ?? 2);
}

// The supervisor consumes its child through this interface. `start` spawns a
// child; `stop` (optionally with a forwarded signal) waits for it to exit and
// resolves with the mapped exit code, resetting to `starting` for the next
// start (admin version switch); `status`/`token` are the queryable state;
// `onReady` is the token-ready notification and `onStateChange` observes the
// machine so the process owner can propagate terminal states.
function createSupervisor(options = {}) {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const diag = options.diag ?? process.stderr;
  const command = options.command ?? DEFAULT_COMMAND;
  const args = options.args ?? [];
  const tokenTimeoutMs = options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;

  let child = null;
  let lastPid = null;
  let state = 'starting';
  let startedAt = null;
  let exitCode = null;
  let tokenBinding = null;
  let live = false;
  let settled = true;
  let stopping = false;
  let stopResolvers = [];
  let timer = null;
  let forwarder = null;

  const readyListeners = new Set();
  const readyWaits = new Set();
  const stateListeners = new Set();

  const note = text => diag.write(`dsh web supervisor: ${text}\n`);

  function snapshot() {
    return {
      state,
      pid: lastPid,
      startedAt,
      exitCode,
      tokenCaptured: tokenBinding !== null,
    };
  }

  function fireStateChange() {
    const current = snapshot();
    for (const listener of stateListeners) listener(current);
  }

  function rejectWaits(reason) {
    for (const waiter of [...readyWaits]) {
      readyWaits.delete(waiter);
      const error = new Error(reason);
      error.state = snapshot();
      waiter.reject(error);
    }
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function closeForwarder() {
    if (!forwarder) return;
    const closing = forwarder;
    forwarder = null;
    closing.close().catch(() => {});
  }

  function captureToken(token) {
    tokenBinding = { pid: child.pid, startedAt, token };
    if (state === 'ready') return; // a reprint keeps the same process token
    state = 'ready';
    clearTimer();
    fireStateChange();
    for (const waiter of [...readyWaits]) {
      readyWaits.delete(waiter);
      waiter.resolve(tokenBinding);
    }
    for (const listener of readyListeners) listener(tokenBinding);
  }

  function onDeath(code, signal) {
    if (settled) return;
    settled = true;
    live = false;
    clearTimer();
    const mapped = mapExitCode(code, signal);
    closeForwarder();
    if (stopping) {
      stopping = false;
      const resolvers = stopResolvers;
      stopResolvers = [];
      child = null;
      lastPid = null;
      startedAt = null;
      exitCode = null;
      tokenBinding = null;
      state = 'starting';
      for (const resolve of resolvers) resolve(mapped);
      rejectWaits('supervisor stopped before the launch token was captured');
      fireStateChange();
      return;
    }
    child = null;
    exitCode = mapped;
    tokenBinding = null;
    state = 'exited';
    rejectWaits('dsh exited before the launch token was captured');
    fireStateChange();
  }

  async function start() {
    if (child) throw new Error('supervisor already owns a running child');
    live = true;
    settled = false;
    stopping = false;
    stopResolvers = [];
    tokenBinding = null;
    exitCode = null;
    startedAt = Date.now();
    state = 'starting';
    child = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    lastPid = child.pid;
    child.on('exit', (code, signal) => onDeath(code, signal));
    child.on('error', error => {
      note(`failed to start ${command}: ${error.code ?? error.message}`);
      onDeath(127, null);
    });
    mirrorStream(child.stdout, out, line => {
      if (!live) return;
      const token = extractLaunchToken(line);
      if (token !== null) {
        if (state === 'starting' || state === 'token-timeout' || state === 'ready') captureToken(token);
        return;
      }
      if (line.startsWith(LAUNCH_LINE_PREFIX)) {
        note('rejected a "dsh web:" line without a usable 43-character launch token');
      }
    });
    mirrorStream(child.stderr, err);
    timer = setTimeout(() => {
      timer = null;
      if (state !== 'starting') return;
      state = 'token-timeout';
      note(`no launch token within ${tokenTimeoutMs} ms; state is token-timeout; the manual ?token= URL remains the fallback`);
      fireStateChange();
    }, tokenTimeoutMs);
    fireStateChange();
    if (options.forward) {
      forwarder = createForwarder(options.forward);
      try {
        await forwarder.listen();
      } catch (error) {
        closeForwarder();
        child.kill('SIGTERM');
        note(`web forwarder failed: ${error.message}`);
        throw error;
      }
    }
    return tokenBinding;
  }

  function stop(signal = 'SIGTERM') {
    if (!child) return Promise.resolve(exitCode ?? 0);
    if (!stopping) {
      stopping = true;
      child.kill(signal);
    }
    return new Promise(resolve => stopResolvers.push(resolve));
  }

  function status() {
    return snapshot();
  }

  function token() {
    return tokenBinding ? tokenBinding.token : null;
  }

  function onReady(listener) {
    if (typeof listener === 'function') readyListeners.add(listener);
    if (state === 'ready') {
      if (typeof listener === 'function') listener(tokenBinding);
      return Promise.resolve(tokenBinding);
    }
    if (state === 'exited') {
      const error = new Error('dsh exited before the launch token was captured');
      error.state = snapshot();
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      readyWaits.add({ resolve, reject });
    });
  }

  function onStateChange(listener) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }

  return { start, stop, status, token, onReady, onStateChange };
}

async function main() {
  const dshArgs = process.argv.slice(2);
  const targetPort = webPort(dshArgs);
  const listenHost = process.env.DSH_WEB_SUPERVISOR_LISTEN_ADDRESS
    ?? selectAddress(os.networkInterfaces(), process.env.DSH_WEB_RELAY_INTERFACE);
  const forward = process.env.DSH_WEB_SUPERVISOR_NO_LISTENER === '1' ? null : {
    host: listenHost,
    port: targetPort,
    targetHost: '127.0.0.1',
    targetPort,
  };
  const supervisor = createSupervisor({
    command: process.env.DSH_WEB_SUPERVISOR_CHILD ?? DEFAULT_COMMAND,
    args: dshArgs,
    forward,
  });
  try {
    await supervisor.start();
  } catch (error) {
    console.error(`dsh web supervisor: ${error.message}`);
    process.exit(1);
  }
  if (forward) {
    console.log(`dsh web supervisor: ${listenHost}:${targetPort} -> 127.0.0.1:${targetPort} (pid ${supervisor.status().pid})`);
  }

  let shuttingDown = false;
  supervisor.onStateChange(current => {
    if (shuttingDown) return;
    if (current.state === 'exited') {
      shuttingDown = true;
      process.exit(current.exitCode ?? 127);
    }
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const code = await supervisor.stop(signal);
      process.exit(code);
    });
  }
}

module.exports = {
  DEFAULT_TOKEN_TIMEOUT_MS,
  createForwarder,
  createSupervisor,
  extractLaunchToken,
  mapExitCode,
  selectAddress,
  webPort,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`dsh web supervisor: ${error.message}`);
    process.exit(1);
  });
}
