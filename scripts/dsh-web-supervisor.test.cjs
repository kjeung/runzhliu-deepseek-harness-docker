'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const { createSupervisor } = require('./dsh-web-supervisor.cjs');

const supervisorPath = path.join(__dirname, 'dsh-web-supervisor.cjs');
const token = () => crypto.randomBytes(32).toString('base64url');
const HOLD = "trap 'exit 0' TERM\nwhile :; do sleep 0.1; done";

let workDir;
before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-supervisor-test-'));
});
after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function childScript(name, body) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function memorySink() {
  return {
    chunks: [],
    write(chunk) { this.chunks.push(chunk); return true; },
    text() { return this.chunks.join(''); },
  };
}

function startSupervisor(script, { tokenTimeoutMs = 500 } = {}) {
  const sink = { out: memorySink(), err: memorySink(), diag: memorySink() };
  const supervisor = createSupervisor({
    command: script,
    tokenTimeoutMs,
    out: sink.out,
    err: sink.err,
    diag: sink.diag,
  });
  return { supervisor, sink, started: supervisor.start() };
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition was not met before the timeout');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

test('the current single-URL launch line becomes ready and the streams are mirrored verbatim', async t => {
  const expected = token();
  const stdoutText = `boot noise\ndsh web: http://127.0.0.1:3080/?token=${expected}\npost line\n`;
  const stderrText = 'a diagnostic on stderr\n';
  const script = childScript('current-line.sh', [
    "printf 'boot noise\\n'",
    `printf 'dsh web: http://127.0.0.1:3080/?token=${expected}\\n'`,
    "printf 'post line\\n'",
    "printf 'a diagnostic on stderr\\n' >&2",
    HOLD,
  ].join('\n'));
  const { supervisor, sink, started } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const binding = await supervisor.onReady();
  await waitFor(() => sink.out.text() === stdoutText && sink.err.text() === stderrText);
  assert.equal(binding.token, expected);
  assert.equal(supervisor.token(), expected);
  assert.equal(supervisor.status().state, 'ready');
  assert.equal(supervisor.status().tokenCaptured, true);
  assert.equal(sink.out.text(), stdoutText);
  assert.equal(sink.err.text(), stderrText);
  assert.ok(!sink.diag.text().includes(expected), 'supervisor diagnostics must not leak the launch token');
});

test('the older single-line dual-URL shape takes the first URL token', async t => {
  const first = token();
  const second = token();
  const line = `dsh web: http://127.0.0.1:3080/?token=${first} (LAN: http://10.0.0.2:3080/?token=${second})`;
  const script = childScript('dual-url.sh', [
    `printf '${line}\\n'`,
    HOLD,
  ].join('\n'));
  const { supervisor, started } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const binding = await supervisor.onReady();
  assert.equal(binding.token, first);
  assert.notEqual(binding.token, second);
});

test('a legacy no-token line is never treated as ready: token-timeout, then the exit is recorded', async t => {
  const script = childScript('legacy.sh', [
    "printf 'dsh web: http://127.0.0.1:3080 (LAN: http://10.0.0.2:3080)\\n'",
    "printf 'dsh web: opening the default browser; pass --no-open to disable\\n'",
    'sleep 0.7',
  ].join('\n'));
  const { supervisor, started } = startSupervisor(script, { tokenTimeoutMs: 300 });
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const pending = supervisor.onReady().then(
    () => { throw new Error('the supervisor became ready without a launch token'); },
    rejection => rejection,
  );
  await waitFor(() => supervisor.status().state === 'token-timeout');
  assert.equal(supervisor.token(), null);
  const error = await pending;
  assert.equal(error.state.state, 'exited');
  assert.equal(error.state.tokenCaptured, false);
});

test('stderr decoys and browser-handoff lines never capture a token', async t => {
  const expected = token();
  const decoy = 'dsh web: listening on 10.0.0.2 over plain HTTP; restrict this port to a trusted proxy or network\n';
  const handoff = 'dsh web: opening the default browser; pass --no-open to disable\n';
  const script = childScript('decoys.sh', [
    `printf '${decoy.replace(/\n/g, '\\n')}' >&2`,
    `printf '${handoff.replace(/\n/g, '\\n')}'`,
    `printf 'dsh web: http://127.0.0.1:3080/?token=${expected}\\n'`,
    HOLD,
  ].join('\n'));
  const { supervisor, sink, started } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const binding = await supervisor.onReady();
  await waitFor(() => sink.err.text() === decoy && sink.out.text().includes(handoff));
  assert.equal(binding.token, expected);
  assert.equal(sink.err.text(), decoy);
  assert.ok(sink.out.text().includes(handoff));
  assert.ok(!sink.diag.text().includes(expected), 'rejection diagnostics must not leak the token');
});

test('duplicate and empty token parameters are rejected until a valid line arrives', async t => {
  const repeated = token();
  const expected = token();
  const script = childScript('duplicates.sh', [
    `printf 'dsh web: http://127.0.0.1:3080/?token=${repeated}&token=${repeated}\\n'`,
    "printf 'dsh web: http://127.0.0.1:3080/?token=\\n'",
    `printf 'dsh web: http://127.0.0.1:3080/?token=${expected}\\n'`,
    HOLD,
  ].join('\n'));
  const { supervisor, sink, started } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const binding = await supervisor.onReady();
  assert.equal(binding.token, expected);
  assert.notEqual(binding.token, repeated);
  assert.ok(!sink.diag.text().includes(repeated), 'rejection diagnostics must not leak the rejected token');
  assert.ok(!sink.diag.text().includes(expected));
});

test('a token split across chunk boundaries reassembles into one byte-identical line', async t => {
  const expected = token();
  const script = childScript('chunks.sh', [
    "printf 'dsh web: http://127.0.0.1:3080/?to'",
    'sleep 0.15',
    `printf 'ken=${expected}\\n'`,
    HOLD,
  ].join('\n'));
  const { supervisor, sink, started } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const binding = await supervisor.onReady();
  assert.equal(binding.token, expected);
  assert.equal(sink.out.text(), `dsh web: http://127.0.0.1:3080/?token=${expected}\n`);
});

test('a child that exits before the token leaves a queryable failure state', async t => {
  const script = childScript('early-exit.sh', [
    "printf 'startup audit failed\\n'",
    'exit 3',
  ].join('\n'));
  const { supervisor, started } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  await started;
  const pending = supervisor.onReady().then(
    () => { throw new Error('the supervisor became ready after the child exited'); },
    rejection => rejection,
  );
  await waitFor(() => supervisor.status().state === 'exited');
  assert.equal(supervisor.status().exitCode, 3);
  assert.equal(supervisor.token(), null);
  const error = await pending;
  assert.equal(error.state.state, 'exited');
  assert.equal(error.state.exitCode, 3);
});

test('explicit stop resets to starting and a fresh start recaptures a rotated token', async t => {
  const tokenFile = path.join(workDir, 'rotated-token');
  const script = childScript('rotation.sh', [
    "trap 'exit 0' TERM",
    "printf 'dsh web: http://127.0.0.1:3080/?token=%s\\n' \"$(cat " + tokenFile + ")\"",
    'while :; do sleep 0.1; done',
  ].join('\n'));
  const first = token();
  const second = token();
  fs.writeFileSync(tokenFile, first);
  const { supervisor } = startSupervisor(script);
  t.after(() => supervisor.stop('SIGKILL').catch(() => {}));
  const binding = await supervisor.onReady();
  assert.equal(binding.token, first);
  const stopped = await supervisor.stop();
  assert.equal(stopped, 0, 'stop resolves with the child exit code of the explicit stop');
  assert.equal(supervisor.status().state, 'starting');
  assert.equal(supervisor.status().exitCode, null);
  assert.equal(supervisor.token(), null, 'the token dies with its process');
  fs.writeFileSync(tokenFile, second);
  await supervisor.start();
  const rotated = await supervisor.onReady();
  assert.equal(rotated.token, second);
  assert.notEqual(rotated.token, first);
});

test('an explicit --trusted-host on the command line fails closed at startup', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, [supervisorPath, 'web', '--no-open', '--trusted-host', 'evil.test'], {
    env: { ...process.env, DSH_WEB_SUPERVISOR_NO_LISTENER: '1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});

test('DSH_TRUSTED_HOSTS is appended as repeated --trusted-host arguments for dsh', { timeout: 15000 }, async t => {
  const script = childScript('trusted.sh', ["printf 'argv:%s\\n' \"$*\"", HOLD].join('\n'));
  const child = spawn(process.execPath, [supervisorPath, 'web', '--no-open'], {
    env: {
      ...process.env,
      DSH_WEB_SUPERVISOR_CHILD: script,
      DSH_WEB_SUPERVISOR_NO_LISTENER: '1',
      DSH_TRUSTED_HOSTS: 'dsh.test,other.test:8443',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.match(output, /--trusted-host dsh\.test --trusted-host other\.test:8443/);
});

test('the supervisor process forwards SIGTERM to its child and propagates the mapped code', { timeout: 15000 }, async t => {
  const script = childScript('sigterm.sh', ["trap 'exit 42' TERM", 'while :; do sleep 0.1; done'].join('\n'));
  const child = spawn(process.execPath, [supervisorPath, 'web', '--no-open'], {
    env: { ...process.env, DSH_WEB_SUPERVISOR_CHILD: script, DSH_WEB_SUPERVISOR_NO_LISTENER: '1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  await new Promise(resolve => setTimeout(resolve, 600));
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 42, 'the child trap code proves the signal reached dsh through the supervisor');
});

test('the supervisor process propagates a natural non-zero child exit code', { timeout: 15000 }, async t => {
  const script = childScript('crash.sh', ["printf 'fatal startup error\\n'", 'exit 7'].join('\n'));
  const child = spawn(process.execPath, [supervisorPath, 'web', '--no-open'], {
    env: { ...process.env, DSH_WEB_SUPERVISOR_CHILD: script, DSH_WEB_SUPERVISOR_NO_LISTENER: '1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  const [code] = await once(child, 'exit');
  assert.equal(code, 7);
});

test('an unresolvable listen interface fails closed', { timeout: 15000 }, async t => {
  const script = childScript('keepalive.sh', [HOLD].join('\n'));
  const child = spawn(process.execPath, [supervisorPath, 'web', '--no-open'], {
    env: { ...process.env, DSH_WEB_SUPERVISOR_CHILD: script, DSH_WEB_RELAY_INTERFACE: 'dsh-test-nonexistent-interface' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});

test('an ephemeral --port refuses to start (membership in the fixed-port contract)', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, [supervisorPath, 'web', '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_WEB_SUPERVISOR_NO_LISTENER: '1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});
