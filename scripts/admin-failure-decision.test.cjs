'use strict';

// Tests for the admin failure/rollback/reset decision module (spec #16;
// decision #5; map #1). Every test drives the pure functions with explicit
// snapshots — volume layouts, health-check results, log listings, lock state.
// Nothing here opens a socket, touches fs or runs npm; the expected owner uid
// is injected so the suite is independent of whether CI runs as uid 1000.
//
// Style mirrors scripts/admin-version-policy.test.cjs (spec #14; decision #10):
// assert only externally observable outcomes (which entries exist, where the
// flip points, kept/dropped names, returned error codes), not internal fields.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  DECISION_ERROR_CODES,
  FAILURE_BRANCHES,
  KEEP_INSTALL_LOGS,
  RETIRED_DIR_NAME,
  VERSIONED_ENTRY_NAMES,
  installDecision,
  logRotation,
  lockDecision,
  policyCleanupPlan,
  resetDecision,
  rollbackDecision,
} = require('./admin-failure-decision.cjs');

const EXPECTED_UID = 1000;
const ROOT = '/opt/dsh';

// A healthy, owned volume snapshot for the policy preflight.
function ownedVolume(overrides = {}) {
  return {
    expectedUid: EXPECTED_UID,
    ownerUid: EXPECTED_UID,
    writable: true,
    freeBytes: 5000000000,
    registryReachable: true,
    ...overrides,
  };
}

// A version-dir listing, each entry [name, mtimeMs].
function versionDirs(dirs) {
  return dirs.map(([name, mtimeMs]) => ({ name, mtimeMs }));
}

// ---------------------------------------------------------------------------
// lockDecision: one install at a time, rejected not queued
// ---------------------------------------------------------------------------

test('a second request against a held lock is rejected, never queued', () => {
  const result = lockDecision({ heldBy: 'request-a' }, { id: 'request-b' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'rejected');
  assert.equal(result.reason, DECISION_ERROR_CODES.LOCK_CONFLICT);
  assert.equal(result.heldBy, 'request-a');
});

test('the lock holder requesting again is accepted', () => {
  const result = lockDecision({ heldBy: 'request-a' }, { id: 'request-a' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.lockOwner, 'request-a');
});

test('an open lock accepts the requesting id and records the new owner', () => {
  const result = lockDecision(null, { id: 'request-c' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.lockOwner, 'request-c');
});

// ---------------------------------------------------------------------------
// installDecision: preflight verdict branches plus lock conflict
// ---------------------------------------------------------------------------

test('install is cleared when the volume is owned, writable, spacious and reachable', () => {
  const result = installDecision(ownedVolume(), {}, null);
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'cleared');
  assert.equal(result.lock.ok, true);
});

test('install fails closed on owner mismatch (preflight owner branch)', () => {
  const result = installDecision(ownedVolume({ ownerUid: 0 }), {}, null);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'preflight');
  assert.equal(result.error.code, 'preflight-failed');
  assert.equal(result.error.reason, 'owner');
  // root-owned stale layout is the relocation branch (US17)
  assert.equal(result.branch, FAILURE_BRANCHES.STALE_ROOT_OWNED);
  assert.equal(result.relocationHint, RETIRED_DIR_NAME);
  assert.equal(result.recovery, 'fix-volume');
});

test('install fails closed on low free space', () => {
  const result = installDecision(ownedVolume({ freeBytes: 100000000 }), {}, null);
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'space');
  assert.equal(result.branch, undefined);
});

test('install fails closed on an unreachable registry', () => {
  const result = installDecision(ownedVolume({ registryReachable: false }), {}, null);
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'registry');
});

test('install fails closed on an unwritable volume', () => {
  const result = installDecision(ownedVolume({ writable: false }), {}, null);
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'owner');
});

test('a lock conflict short-circuits before any preflight (US9)', () => {
  const result = installDecision(ownedVolume(), { id: 'request-b' }, { heldBy: 'request-a' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'lock');
  assert.equal(result.error.code, DECISION_ERROR_CODES.LOCK_CONFLICT);
  assert.equal(result.recovery, 'rerun-install-to-recover');
});

test('interrupted/cancelled installs promise only rerun-install-to-recover (US10)', () => {
  const result = installDecision(ownedVolume(), { id: 'x' }, { heldBy: 'y' });
  assert.equal(result.recovery, 'rerun-install-to-recover');
});

// ---------------------------------------------------------------------------
// rollbackDecision: flip target selection under cleanup protection
// ---------------------------------------------------------------------------

test('a failed health check flips current back to the newest old version (US4/US6/US7)', () => {
  const volume = {
    currentTarget: ROOT + '/versions/0.3.0',
    pendingVersion: '0.3.0',
    versions: versionDirs([
      ['0.2.0', 1000000],
      ['0.2.1', 2000000],
      ['0.3.0', 3000000],
    ]),
  };
  const result = rollbackDecision({ ok: false }, volume);
  assert.equal(result.ok, true);
  assert.equal(result.flip.from, ROOT + '/versions/0.3.0');
  assert.equal(result.flip.to, '0.2.1');
  // the failed new version stays on the volume (US5)
  assert.equal(result.keepFailedVersion, '0.3.0');
});

test('the failed version and current are excluded from rollback candidates', () => {
  const volume = {
    currentTarget: ROOT + '/versions/0.3.0',
    pendingVersion: '0.3.0',
    versions: versionDirs([
      ['0.2.0', 1000000],
      ['0.3.0', 3000000],
      ['notes', 4000000], // not a version dir: ignored
    ]),
  };
  const result = rollbackDecision({ ok: false }, volume);
  assert.equal(result.ok, true);
  assert.equal(result.flip.to, '0.2.0');
});

test('rollback is a no-flip success when the health check passed', () => {
  const volume = {
    currentTarget: ROOT + '/versions/0.3.0',
    pendingVersion: '0.3.0',
    versions: versionDirs([['0.2.1', 2000000], ['0.3.0', 3000000]]),
  };
  const result = rollbackDecision({ ok: true }, volume);
  assert.equal(result.ok, true);
  assert.equal(result.flip, null);
});

test('a missing health-check result is an explicit error, never a guess', () => {
  const result = rollbackDecision({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DECISION_ERROR_CODES.HEALTH_CHECK_UNREPORTED);
});

test('no rollback candidate is an explicit no-target error', () => {
  const volume = {
    currentTarget: ROOT + '/versions/0.3.0',
    pendingVersion: '0.3.0',
    versions: versionDirs([['0.3.0', 3000000]]),
  };
  const result = rollbackDecision({ ok: false }, volume);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DECISION_ERROR_CODES.ROLLBACK_NO_TARGET);
});

test('a candidate without a usable mtime is never the rollback target', () => {
  const volume = {
    currentTarget: null,
    pendingVersion: '0.3.0',
    versions: versionDirs([
      ['0.2.0', null],
      ['0.3.0', 3000000],
    ]),
  };
  const result = rollbackDecision({ ok: false }, volume);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DECISION_ERROR_CODES.ROLLBACK_TARGET_AMBIGUOUS);
});

test('an undated candidate is surfaced as a warning when another candidate is usable', () => {
  const volume = {
    currentTarget: ROOT + '/versions/0.3.0',
    pendingVersion: '0.3.0',
    versions: versionDirs([
      ['0.2.0', null],
      ['0.2.1', 2000000],
      ['0.3.0', 3000000],
    ]),
  };
  const result = rollbackDecision({ ok: false }, volume);
  assert.equal(result.ok, true);
  assert.equal(result.flip.to, '0.2.1');
  assert.equal(result.warnings.length, 1);
});

test('the rollback target survives the pre-install cleanup plan (US8)', () => {
  // Steady state: current=0.3.0, old=0.2.1 (protected) + 0.2.0. A rollback
  // flips current to 0.2.1; the next install's cleanup must not remove 0.2.1.
  const volume = {
    versionsDir: ROOT + '/versions',
    currentTarget: ROOT + '/versions/0.3.0',
    versions: versionDirs([
      ['0.2.0', 1000000],
      ['0.2.1', 2000000],
      ['0.3.0', 3000000],
    ]),
  };
  const flip = rollbackDecision({ ok: false }, volume);
  assert.equal(flip.ok, true);
  const rollbackTarget = flip.flip.to;
  const cleanup = policyCleanupPlan(volume, '0.4.0');
  assert.ok(cleanup.keep.includes(rollbackTarget));
  assert.ok(!cleanup.remove.includes(rollbackTarget));
});

// ---------------------------------------------------------------------------
// resetDecision: move-aside relocation plan, never delete
// ---------------------------------------------------------------------------

function entryNames(names) {
  return names.map(name => ({ name }));
}

test('reset moves versioned content into a timestamped .retired dir and keeps infrastructure in place', () => {
  const layout = {
    ownerUid: EXPECTED_UID,
    expectedUid: EXPECTED_UID,
    entries: entryNames([
      '.npm-cache',
      '.retired',
      'logs',
      'versions',
      'lib',
      'bin',
      'manager',
      'manager-patch.js',
      'plugins',
      'bin-custom',
      'etc',
      'notes.md', // foreign entry: also relocated, never deleted
    ]),
  };
  const links = [
    { profile: 'default', target: '/opt/dsh/plugins/dsh-browser-desktop' },
    { profile: 'default', target: '/opt/dsh/plugins/dsh-mobile-bridge' },
    { profile: 'default', target: '/opt/dsh/logs/install.log' },
    { profile: 'default', target: '/opt/dsh/.npm-cache' },
  ];
  const result = resetDecision(layout, links, '20261025T040000Z');
  assert.equal(result.ok, true);
  assert.equal(result.branch, null);
  assert.equal(result.retiredRoot, '.retired/20261025T040000Z');
  // infrastructure stays
  assert.deepEqual(result.keepInPlace, ['.npm-cache', '.retired', 'logs']);
  // versioned content moves
  assert.ok(result.relocations.some(move => move.from === 'versions' && move.to === '.retired/20261025T040000Z/versions'));
  assert.ok(result.relocations.some(move => move.from === 'notes.md'));
  // nothing is ever deleted
  assert.deepEqual(result.deletes, []);
});

test('profile links into relocated subdirs are re-pointed, not left dangling (US15)', () => {
  const layout = {
    ownerUid: EXPECTED_UID,
    expectedUid: EXPECTED_UID,
    entries: entryNames(['versions', 'lib', 'plugins']),
  };
  // link targets are volume-relative, matching how the manager records them
  const links = [{ profile: 'default', target: 'plugins/dsh-browser-desktop' }];
  const result = resetDecision(layout, links, 'ts1');
  const update = result.linkUpdates.find(entry => entry.from === 'plugins/dsh-browser-desktop');
  assert.ok(update);
  assert.equal(update.to, '.retired/ts1/dsh-browser-desktop');
});

test('out-of-repo plugin links are left untouched (US16)', () => {
  const layout = {
    ownerUid: EXPECTED_UID,
    expectedUid: EXPECTED_UID,
    entries: entryNames(['plugins']),
  };
  // dsh-mobile-bridge lives outside the install volume entirely
  const links = [
    { profile: 'default', target: '/home/node/.dsh/plugins/dsh-mobile-bridge' },
  ];
  const result = resetDecision(layout, links, 'ts2');
  assert.deepEqual(result.linkUpdates, []);
  assert.equal(result.untouchedLinks.length, 1);
  assert.equal(result.untouchedLinks[0].target, '/home/node/.dsh/plugins/dsh-mobile-bridge');
});

test('links pointing at keep-in-place infrastructure are untouched', () => {
  const layout = {
    ownerUid: EXPECTED_UID,
    expectedUid: EXPECTED_UID,
    entries: entryNames(['versions', 'logs']),
  };
  const links = [{ profile: 'default', target: '/opt/dsh/logs/install.log' }];
  const result = resetDecision(layout, links, 'ts3');
  assert.deepEqual(result.linkUpdates, []);
  assert.equal(result.untouchedLinks.length, 1);
});

test('a stale root-owned install takes the relocation branch with the same move-only plan (US17)', () => {
  const layout = {
    ownerUid: 0,
    expectedUid: EXPECTED_UID,
    entries: entryNames(['versions', 'lib', 'manager']),
  };
  const result = resetDecision(layout, [], 'ts4');
  assert.equal(result.ok, true);
  assert.equal(result.branch, FAILURE_BRANCHES.STALE_ROOT_OWNED);
  assert.ok(result.relocations.length >= 3);
  assert.deepEqual(result.deletes, []);
});

// ---------------------------------------------------------------------------
// logRotation: keep-10 drop-oldest plan
// ---------------------------------------------------------------------------

test('more than 10 dated logs drop the oldest beyond the first 10 (US12)', () => {
  const entries = Array.from({ length: 14 }, (_, index) => ({
    name: 'install-' + String(index + 1).padStart(2, '0') + '.log',
    mtimeMs: (index + 1) * 1000,
  }));
  const result = logRotation({ entries });
  assert.equal(result.keepLimit, KEEP_INSTALL_LOGS);
  assert.equal(result.drop.length, 4);
  assert.deepEqual(result.drop, ['install-01.log', 'install-02.log', 'install-03.log', 'install-04.log']);
  assert.equal(result.keep.length, 10);
  assert.ok(result.keep.includes('install-14.log'));
});

test('at or under 10 logs nothing is dropped', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    name: 'install-' + index + '.log',
    mtimeMs: index * 1000,
  }));
  const result = logRotation({ entries });
  assert.deepEqual(result.drop, []);
  assert.equal(result.keep.length, 10);
});

test('an undated log is always kept, never dropped, with a warning', () => {
  const entries = [
    { name: 'install-01.log', mtimeMs: 1000 },
    { name: 'install-99.log', mtimeMs: null },
  ];
  const result = logRotation({ entries });
  assert.ok(result.keep.includes('install-99.log'));
  assert.deepEqual(result.drop, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /install-99\.log/);
});

test('an empty listing yields an empty keep/drop plan', () => {
  const result = logRotation({ entries: [] });
  assert.deepEqual(result.keep, []);
  assert.deepEqual(result.drop, []);
});

// ---------------------------------------------------------------------------
// VERSIONED_ENTRY_NAMES is the closed relocation vocabulary
// ---------------------------------------------------------------------------

test('the versioned entry vocabulary covers the old manager layout from #5', () => {
  assert.deepEqual([...VERSIONED_ENTRY_NAMES].sort(), [
    'bin',
    'bin-custom',
    'etc',
    'lib',
    'manager',
    'manager-patch.js',
    'plugins',
    'versions',
  ]);
});
