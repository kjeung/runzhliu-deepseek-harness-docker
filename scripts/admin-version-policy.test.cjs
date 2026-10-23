'use strict';

// Tests for the admin version policy (spec #14; decision #10; ADR-0002).
// Every test drives the engine with explicit facts: injected packuments,
// volume snapshots, npmrc text and an injected fetch. Nothing here opens a
// socket, starts docker or runs npm. The expected owner uid is injected so the
// suite is independent of whether CI runs as uid 1000 or 1001.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  BROWSER_USE_PACKAGE,
  DEFAULT_EXPECTED_UID,
  DSH_PACKAGE,
  ERROR_CODES,
  KEEP_OLD_VERSIONS,
  MIN_FREE_BYTES,
  PIN_ARTIFACT_NAME,
  PLAYWRIGHT_MCP_PACKAGE,
  cleanupPlan,
  collectRegistryFacts,
  collectVolumeSnapshot,
  installSpecs,
  listRows,
  preflight,
  readNpmrcText,
  readPin,
  resolveNpmrcAuth,
} = require('./admin-version-policy.cjs');

const PIN = '0.2.1-rc.2';
const NEXT = '0.2.1-rc.3';
const VERSIONS_DIR = '/opt/dsh/versions';

function packument(versions, distTags = {}) {
  const payload = { versions: {}, 'dist-tags': { ...distTags } };
  for (const version of versions) payload.versions[version] = { name: 'fixture', version };
  return payload;
}

// Registry fixture whose two browser-use packages have the same-version
// pairing for every listed version unless a test overrides one side.
function registry({ dsh = [PIN], browserUse, playwrightMcp, distTags = {}, pin = PIN } = {}) {
  return {
    dsh: packument(dsh, distTags),
    browserUse: packument(browserUse ?? dsh),
    playwrightMcp: packument(playwrightMcp ?? browserUse ?? dsh),
    pin,
  };
}

function volume({ currentTarget = null, dirs, warnings = [] } = {}) {
  return {
    versionsDir: VERSIONS_DIR,
    currentTarget,
    versions: dirs.map(([name, mtimeMs]) => ({ name, mtimeMs })),
    warnings,
  };
}

function versionNames(result) {
  return result.rows.map(row => row.version);
}

// ---------------------------------------------------------------------------
// listRows: floor, ordering, annotations, pairing
// ---------------------------------------------------------------------------

test('versions below the pin are hidden and the pin is always listed and tested', () => {
  const result = listRows(registry({
    dsh: ['0.1.5-rc.3', '0.2.0-rc.1', PIN, NEXT],
    browserUse: ['0.1.5-rc.3', '0.2.0-rc.1', PIN, NEXT],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(versionNames(result), [NEXT, PIN]);
  const pinRow = result.rows.find(row => row.version === PIN);
  assert.equal(pinRow.tested, true);
  assert.equal(result.rows.find(row => row.version === NEXT).tested, false);
});

test('an out-of-order packument is filtered by the explicit comparator, not publication order', () => {
  const result = listRows(registry({
    dsh: ['0.2.1-rc.9', '0.1.5-rc.3', PIN, '0.2.1-rc.10', '0.2.0-beta.1'],
    browserUse: ['0.2.1-rc.9', '0.1.5-rc.3', PIN, '0.2.1-rc.10', '0.2.0-beta.1'],
  }));
  assert.deepEqual(versionNames(result), ['0.2.1-rc.10', '0.2.1-rc.9', PIN]);
});

test('pre-release comparison orders rc.10 above rc.2, alpha < beta < rc, and stable above a same-triple pre-release', () => {
  const versions = ['0.3.0-alpha.1', '0.3.0-beta.1', '0.3.0-rc.2', '0.3.0', '0.3.0-rc.10', PIN];
  const result = listRows(registry({ dsh: versions, browserUse: versions }));
  assert.deepEqual(versionNames(result), ['0.3.0', '0.3.0-rc.10', '0.3.0-rc.2', '0.3.0-beta.1', '0.3.0-alpha.1', PIN]);
});

test('dist-tag hits are derived from the packument dist-tags', () => {
  const result = listRows(registry({
    dsh: [PIN, NEXT],
    distTags: { latest: PIN, next: NEXT, alpha: NEXT },
  }));
  const row = version => result.rows.find(candidate => candidate.version === version);
  assert.deepEqual(row(PIN).distTags, ['latest']);
  assert.deepEqual(row(NEXT).distTags, ['next', 'alpha']);
});

test('a version is installable only when both browser-use packages have the exact same version', () => {
  const result = listRows(registry({ dsh: [PIN, NEXT] }));
  assert.equal(result.rows.find(row => row.version === NEXT).installable, true);
  assert.equal(result.rows.find(row => row.version === NEXT).reason, null);
  assert.equal(result.rows.find(row => row.version === NEXT).prerelease, 'rc');
});

test('a missing same-version browser-use package marks the row pairing-missing', () => {
  const result = listRows(registry({
    dsh: [PIN, NEXT],
    browserUse: [PIN, NEXT],
    playwrightMcp: [PIN],
  }));
  const row = result.rows.find(candidate => candidate.version === NEXT);
  assert.equal(result.ok, true);
  assert.equal(row.installable, false);
  assert.equal(row.reason, ERROR_CODES.PAIRING_MISSING);
});

test('a dist-tag that points at a version without the exact pairing is still rejected', () => {
  const result = listRows(registry({
    dsh: [PIN, '0.2.1-rc.5'],
    browserUse: [PIN, '0.2.1-rc.5'],
    playwrightMcp: [PIN],
    distTags: { next: '0.2.1-rc.5' },
  }));
  const row = result.rows.find(candidate => candidate.version === '0.2.1-rc.5');
  assert.deepEqual(row.distTags, ['next']);
  assert.equal(row.installable, false);
  assert.equal(row.reason, ERROR_CODES.PAIRING_MISSING);
});

// ---------------------------------------------------------------------------
// listRows: fail-closed errors
// ---------------------------------------------------------------------------

test('an unreachable or empty registry is an explicit registry-unreachable error', () => {
  assert.equal(listRows({ ...registry(), dsh: null }).error.code, ERROR_CODES.REGISTRY_UNREACHABLE);
  const empty = listRows({ ...registry(), dsh: packument([]) });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, ERROR_CODES.REGISTRY_UNREACHABLE);
});

test('an unreachable browser-use packument is registry-unreachable, never pairing-missing', () => {
  const result = listRows({ ...registry(), browserUse: null });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.REGISTRY_UNREACHABLE);
  assert.equal(result.rows, undefined);
});

test('a pin absent from the dsh packument is pin-missing', () => {
  const result = listRows(registry({ dsh: [NEXT], browserUse: [NEXT], pin: PIN }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.PIN_MISSING);
});

test('a missing pin fact is pin-missing rather than a silent floor', () => {
  const result = listRows({ ...registry(), pin: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.PIN_MISSING);
});

// ---------------------------------------------------------------------------
// installSpecs: exact membership and pairing
// ---------------------------------------------------------------------------

test('installSpecs returns the exact DSH plus both browser-use specs', () => {
  const result = installSpecs({ ...registry({ dsh: [PIN, NEXT] }), version: NEXT });
  assert.equal(result.ok, true);
  assert.equal(result.version, NEXT);
  assert.equal(result.tested, false);
  assert.deepEqual(result.specs, [
    `${DSH_PACKAGE}@${NEXT}`,
    `${BROWSER_USE_PACKAGE}@${NEXT}`,
    `${PLAYWRIGHT_MCP_PACKAGE}@${NEXT}`,
  ]);
});

test('installSpecs rejects tag names and range expressions as non-members', () => {
  for (const version of ['latest', 'next', '^0.2.1', '0.2.1-rc.2 || 0.3.0', `${PIN} `]) {
    const result = installSpecs({ ...registry(), version });
    assert.equal(result.ok, false, version);
    assert.equal(result.error.code, ERROR_CODES.VERSION_NOT_FOUND, version);
  }
});

test('installSpecs rejects a version below the floor even when the registry publishes it', () => {
  const result = installSpecs({
    ...registry({ dsh: ['0.1.5-rc.3', PIN], browserUse: ['0.1.5-rc.3', PIN] }),
    version: '0.1.5-rc.3',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.VERSION_NOT_FOUND);
});

test('installSpecs refuses a listed version whose exact pairing is missing', () => {
  const result = installSpecs({
    ...registry({ dsh: [PIN, NEXT], browserUse: [PIN, NEXT], playwrightMcp: [PIN] }),
    version: NEXT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.PAIRING_MISSING);
});

// ---------------------------------------------------------------------------
// npmrc: bearer-only, longest prefix, unsupported forms fail closed
// ---------------------------------------------------------------------------

test('a scoped bearer _authToken for the registry origin is used', () => {
  const result = resolveNpmrcAuth({
    npmrcText: '//registry.example.com/:_authToken=token-value',
    registryUrl: 'https://registry.example.com/',
    env: {},
  });
  assert.deepEqual(result, { ok: true, token: 'token-value' });
});

test('the longest matching registry path wins and ${VAR} is expanded', () => {
  const result = resolveNpmrcAuth({
    npmrcText: [
      '//registry.example.com/:_authToken=root-token',
      '//registry.example.com/team/npm/:_authToken=${TEAM_TOKEN}',
    ].join('\n'),
    registryUrl: 'https://registry.example.com/team/npm/',
    env: { TEAM_TOKEN: 'team-token' },
  });
  assert.deepEqual(result, { ok: true, token: 'team-token' });
});

test('a non-default port participates in same-origin matching', () => {
  const result = resolveNpmrcAuth({
    npmrcText: '//registry.example.com:8443/:_authToken=port-token',
    registryUrl: 'https://registry.example.com:8443/',
    env: {},
  });
  assert.deepEqual(result, { ok: true, token: 'port-token' });
});

test('an npmrc with no matching origin or path yields no token', () => {
  assert.deepEqual(resolveNpmrcAuth({
    npmrcText: '//other.example.com/:_authToken=other-token',
    registryUrl: 'https://registry.example.com/',
    env: {},
  }), { ok: true, token: null });
  assert.deepEqual(resolveNpmrcAuth({
    npmrcText: '//registry.example.com/other/:_authToken=path-token',
    registryUrl: 'https://registry.example.com/team/',
    env: {},
  }), { ok: true, token: null });
});

test('basic auth forms fail closed as auth-unsupported without echoing the secret', () => {
  const secret = 'c2VjcmV0LWJhc2lj';
  const result = resolveNpmrcAuth({
    npmrcText: `_auth=${secret}`,
    registryUrl: 'https://registry.example.com/',
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.AUTH_UNSUPPORTED);
  assert.ok(!JSON.stringify(result).includes(secret));

  const password = resolveNpmrcAuth({
    npmrcText: '//registry.example.com/:_password=another-secret',
    registryUrl: 'https://registry.example.com/',
    env: {},
  });
  assert.equal(password.ok, false);
  assert.equal(password.error.code, ERROR_CODES.AUTH_UNSUPPORTED);
});

test('a matched token that expands to an empty value fails closed', () => {
  const result = resolveNpmrcAuth({
    npmrcText: '//registry.example.com/:_authToken=${MISSING_TOKEN}',
    registryUrl: 'https://registry.example.com/',
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.AUTH_UNSUPPORTED);
});

// ---------------------------------------------------------------------------
// cleanupPlan
// ---------------------------------------------------------------------------

test('the cleanup plan is computed for the pending version: current + 2 old + install removes the oldest', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 300], ['0.2.1-rc.1', 100], ['0.2.0-rc.3', 200]],
  }), NEXT);
  assert.deepEqual(plan.remove, ['0.2.1-rc.1']);
  const oldAfterFlip = plan.keep.filter(version => version !== NEXT);
  assert.ok(oldAfterFlip.length <= KEEP_OLD_VERSIONS, `expected at most ${KEEP_OLD_VERSIONS} old versions, got ${oldAfterFlip.join(', ')}`);
  assert.deepEqual(plan.keep, [NEXT, PIN, '0.2.0-rc.3']);
});

test('the current realpath target is never in the removal plan, even when it is the oldest directory', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 50], ['0.2.1-rc.1', 100], ['0.2.0-rc.3', 200]],
  }), NEXT);
  assert.deepEqual(plan.remove, ['0.2.1-rc.1']);
  assert.ok(!plan.remove.includes(PIN));
});

test('the most recent old version is protected as the rollback anchor', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 100], ['0.2.1-rc.1', 200], ['0.2.0-rc.3', 50]],
  }), NEXT);
  assert.deepEqual(plan.remove, ['0.2.0-rc.3']);
  assert.ok(plan.keep.includes('0.2.1-rc.1'));
});

test('removals are ordered oldest-first by mtime', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/0.2.2-rc.1`,
    dirs: [
      ['0.2.2-rc.1', 500],
      ['0.2.1-rc.1', 100],
      ['0.2.1-rc.2', 200],
      ['0.2.1-rc.3', 300],
      ['0.2.1-rc.4', 400],
    ],
  }), '0.2.2-rc.2');
  assert.deepEqual(plan.remove, ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3']);
  assert.ok(plan.keep.includes('0.2.1-rc.4'));
});

test('directories without a usable mtime are excluded with a warning', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 300], ['0.2.1-rc.1', null], ['0.2.0-rc.3', 200]],
  }), NEXT);
  assert.deepEqual(plan.remove, []);
  assert.ok(plan.warnings.some(warning => warning.includes('0.2.1-rc.1')), plan.warnings.join('\n'));
});

test('only version-shaped directory names are cleanup candidates, including a future stable version', () => {
  const filtered = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 300], ['0.3.0', 200], ['cache', 10], ['0.3', 10], ['v0.4.0', 10]],
  }), '0.3.1');
  assert.deepEqual(filtered.remove, []);
  assert.ok(filtered.keep.includes('0.3.0'));
  assert.ok(!filtered.keep.includes('cache'));
  assert.ok(!filtered.keep.includes('0.3'));
  assert.ok(!filtered.keep.includes('v0.4.0'));

  const deleted = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 300], ['0.3.0', 50], ['0.2.0-rc.1', 100]],
  }), '0.3.1');
  assert.deepEqual(deleted.remove, ['0.3.0']);
});

test('reinstalling a version already on disk does not over-delete', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 300], ['0.2.1-rc.1', 100], ['0.2.0-rc.3', 200]],
  }), '0.2.1-rc.1');
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep.filter(version => version !== '0.2.1-rc.1').length, 2);
});

test('adapter warnings from the volume snapshot are carried into the cleanup plan', () => {
  const plan = cleanupPlan(volume({
    currentTarget: `${VERSIONS_DIR}/${PIN}`,
    dirs: [[PIN, 300]],
    warnings: ['stat of one directory failed'],
  }), NEXT);
  assert.ok(plan.warnings.includes('stat of one directory failed'));
});

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

test('preflight passes owner, space (exactly 1.5 GB) and registry in order', () => {
  const result = preflight({
    ownerUid: DEFAULT_EXPECTED_UID,
    writable: true,
    freeBytes: MIN_FREE_BYTES,
    registryReachable: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, [
    { name: 'owner', ok: true },
    { name: 'space', ok: true },
    { name: 'registry', ok: true },
  ]);
});

test('the expected owner uid is injectable, so CI uid 1001 is not hardcoded to 1000', () => {
  const uid = process.getuid();
  const result = preflight({ ownerUid: uid, writable: true, freeBytes: 2_000_000_000, registryReachable: true, expectedUid: uid });
  assert.equal(result.ok, true);
  assert.equal(result.checks[0].ok, true);

  const mismatch = preflight({ ownerUid: uid, writable: true, freeBytes: 2_000_000_000, registryReachable: true, expectedUid: uid + 1 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, ERROR_CODES.PREFLIGHT_FAILED);
  assert.equal(mismatch.error.reason, 'owner');
});

test('a non-writable volume fails the owner check and short-circuits the rest', () => {
  const result = preflight({ ownerUid: DEFAULT_EXPECTED_UID, writable: false, freeBytes: 0, registryReachable: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'owner');
  assert.equal(result.checks.length, 1);
});

test('space below 1.5 GB fails after owner and short-circuits the registry check', () => {
  const result = preflight({ ownerUid: DEFAULT_EXPECTED_UID, writable: true, freeBytes: MIN_FREE_BYTES - 1, registryReachable: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'space');
  assert.equal(result.checks.length, 2);
});

test('an unreachable registry is the last check to run', () => {
  const result = preflight({ ownerUid: DEFAULT_EXPECTED_UID, writable: true, freeBytes: 2_000_000_000, registryReachable: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'registry');
  assert.deepEqual(result.checks.map(check => check.name), ['owner', 'space', 'registry']);
});

test('BigInt statfs bytes and adapter warnings flow through preflight', () => {
  const result = preflight({
    ownerUid: DEFAULT_EXPECTED_UID,
    writable: true,
    freeBytes: BigInt(MIN_FREE_BYTES),
    registryReachable: true,
    warnings: ['statfs used a fallback'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ['statfs used a fallback']);
});

test('the space threshold is decimal 1.5 GB, not 1.5 GiB', () => {
  assert.equal(MIN_FREE_BYTES, 1_500_000_000);
  assert.notEqual(MIN_FREE_BYTES, 1.5 * 1024 ** 3);
  assert.equal(preflight({ ownerUid: DEFAULT_EXPECTED_UID, writable: true, freeBytes: MIN_FREE_BYTES, registryReachable: true }).ok, true);
  assert.equal(preflight({ ownerUid: DEFAULT_EXPECTED_UID, writable: true, freeBytes: MIN_FREE_BYTES - 1, registryReachable: true }).error.reason, 'space');
});

// ---------------------------------------------------------------------------
// Adapters: injected fetch, temp-dir volume snapshot, pin artifact
// ---------------------------------------------------------------------------

test('readPin reads only the read-only DSH_PIN artifact, never DSH_VERSION', () => {
  assert.equal(readPin({ env: { [PIN_ARTIFACT_NAME]: PIN } }), PIN);
  assert.throws(
    () => readPin({ env: { DSH_VERSION: PIN } }),
    error => error.code === ERROR_CODES.PIN_MISSING,
  );
  assert.throws(
    () => readPin({ env: {} }),
    error => error.code === ERROR_CODES.PIN_MISSING,
  );
});

test('readNpmrcText honours NPM_CONFIG_USERCONFIG and treats a missing default as no credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-npmrc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'custom-npmrc');
  fs.writeFileSync(file, '//registry.example.com/:_authToken=token\n');
  assert.match(await readNpmrcText({ env: { NPM_CONFIG_USERCONFIG: file } }), /_authToken=token/);
  assert.equal(await readNpmrcText({ env: {}, home: root }), null);
});

test('collectRegistryFacts fetches all three packuments with the bearer token', async () => {
  const calls = [];
  const payloads = [
    packument([PIN]),
    packument([PIN]),
    packument([PIN]),
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => payloads[calls.length - 1] };
  };
  const facts = await collectRegistryFacts({
    registryUrl: 'https://registry.example.com/team/npm/',
    npmrcText: '//registry.example.com/:_authToken=registry-token',
    env: {},
    fetchImpl,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.url), [
    'https://registry.example.com/team/npm/%40deepseek-ai%2Fdsh',
    'https://registry.example.com/team/npm/%40deepseek-ai%2Fdsh-browser-use',
    'https://registry.example.com/team/npm/%40deepseek-ai%2Fdsh-experimental-browser-use-playwright-mcp',
  ]);
  for (const call of calls) assert.equal(call.options.headers.authorization, 'Bearer registry-token');
  assert.deepEqual(versionNames(listRows({ ...facts, pin: PIN })), [PIN]);
});

test('a failed packument fetch is registry-unreachable and never logs the token', async () => {
  let observed;
  const fetchImpl = async (url, options) => {
    observed = options;
    throw new Error('network down');
  };
  await assert.rejects(
    collectRegistryFacts({
      registryUrl: 'https://registry.example.com/',
      npmrcText: '//registry.example.com/:_authToken=super-secret',
      env: {},
      fetchImpl,
    }),
    error => error.code === ERROR_CODES.REGISTRY_UNREACHABLE && !String(error.message).includes('super-secret'),
  );
  assert.equal(observed.headers.authorization, 'Bearer super-secret');
});

test('unsupported npmrc credentials fail before any registry request', async () => {
  let requested = false;
  await assert.rejects(
    collectRegistryFacts({
      registryUrl: 'https://registry.example.com/',
      npmrcText: '_auth=secret',
      env: {},
      fetchImpl: async () => {
        requested = true;
        throw new Error('must not fetch');
      },
    }),
    error => error.code === ERROR_CODES.AUTH_UNSUPPORTED,
  );
  assert.equal(requested, false);
});

test('collectVolumeSnapshot captures versions mtimes, current realpath, owner, writability and free bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-volume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const versionsDir = path.join(root, 'versions');
  fs.mkdirSync(versionsDir);
  for (const [name, seconds] of [[PIN, 100], [NEXT, 200]]) {
    const dir = path.join(versionsDir, name);
    fs.mkdirSync(dir);
    const stamp = new Date(2024, 0, 1, 0, 0, seconds);
    fs.utimesSync(dir, stamp, stamp);
  }
  fs.symlinkSync(path.join('versions', PIN), path.join(root, 'current'));

  const snapshot = await collectVolumeSnapshot({ root });
  assert.equal(snapshot.ownerUid, process.getuid());
  assert.equal(snapshot.writable, true);
  assert.equal(typeof snapshot.freeBytes, 'number');
  assert.ok(snapshot.freeBytes >= 0);
  assert.equal(snapshot.currentTarget, fs.realpathSync(path.join(versionsDir, PIN)));
  assert.deepEqual(snapshot.versions.map(entry => entry.name).sort(), [PIN, NEXT].sort());
  for (const entry of snapshot.versions) assert.equal(typeof entry.mtimeMs, 'number');

  const ownerCheck = preflight({ ...snapshot, expectedUid: process.getuid(), registryReachable: true });
  assert.equal(ownerCheck.checks[0].ok, true, 'the injected uid drives the owner check');
});
