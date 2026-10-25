#!/usr/bin/env node
'use strict';

// admin failure/rollback/reset decision module (spec #16; decision #5; map #1).
//
// Pure decision module plus thin fact-collection adapters, mirroring the
// admin-version-policy seam (spec #14; decision #10; ADR-0002): the pure
// functions below never touch fs, network or child processes; they consume
// explicit snapshots and return plain data. The adapters at the bottom only
// collect facts.
//
//   installDecision(snapshot, policyOutput, lockState)
//       preflight verdict (reusing the policy module's preflight) or lock-conflict
//   rollbackDecision(healthCheckResult, volumeSnapshot)
//       flip target selection for the post-install health check failure path
//   resetDecision(volumeLayout, profileLinks, timestamp)
//       relocated-subdirs plan under a .retired/<ts> directory, plus the profile
//       plugin-link updates that must accompany it (move-aside, never delete)
//   logRotation(logsListing)
//       keep-10 drop-oldest plan for the volume logs/ directory
//   lockDecision(lockState, request)
//       single install lock: a second concurrent request is rejected, not queued
//
// Route C (decision #5): the live /app/manager entrypoint stays PID 1 and owns
// I/O; this module is the single source of decision logic it calls. Rollback
// reuses the same 'current' flip mechanism as #10/#14; it is never a download
// and never depends on the registry. Interrupted/cancelled installs are
// promised only as rerun-install-to-recover, not as a resumable site.
//
// The stale-root-owned layout branch (US17): a volume whose owner is not the
// expected uid is not a generic preflight failure — it is the trigger for the
// reset relocation branch, moving the old content aside into .retired/ so the
// new layout can take over.
//
// Supply chain stance (from #2 measured fact 5): install commands keep the npm
// 11.19.1 default of refusing lifecycle scripts; skipped scripts are recorded
// in the install log, they are not forced on with --allow-scripts.

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_EXPECTED_UID,
  ERROR_CODES: POLICY_ERROR_CODES,
  PREFLIGHT_REASONS,
  preflight: policyPreflight,
  cleanupPlan: policyCleanupPlan,
} = require('./admin-version-policy.cjs');

const KEEP_INSTALL_LOGS = 10;
const RETIRED_DIR_NAME = '.retired';
const LOGS_DIR_NAME = 'logs';
const NPM_CACHE_DIR_NAME = '.npm-cache';

// The versioned content of the install volume: what an install lays down and
// what a reset relocates. Everything else (the shared npm cache, the log
// directory, prior retired snapshots) is infrastructure and is never
// relocated or deleted by the harness.
const VERSIONED_ENTRY_NAMES = Object.freeze([
  'versions',
  'lib',
  'bin',
  'manager',
  'manager-patch.js',
  'plugins',
  'bin-custom',
  'etc',
]);

const FAILURE_BRANCHES = Object.freeze({
  STALE_ROOT_OWNED: 'stale-root-owned',
  PENDING_VERSION_DIR_RETIRED: 'pending-version-dir-retired',
});

const DECISION_ERROR_CODES = Object.freeze({
  LOCK_CONFLICT: 'lock-conflict',
  ROLLBACK_NO_TARGET: 'rollback-no-target',
  ROLLBACK_TARGET_AMBIGUOUS: 'rollback-target-ambiguous',
  HEALTH_CHECK_UNREPORTED: 'health-check-unreported',
  RESET_NOT_OWNED: 'reset-not-owned',
  RESET_LOCKED: 'reset-locked',
  PROFILE_LINK_DANGLING: 'profile-link-dangling',
});

const DECISION_FAILURE = Object.freeze({
  LOCK: 'lock',
  ROLLBACK: 'rollback',
  RESET: 'reset',
});

function failure(code, message, extra) {
  const error = { code, message };
  if (extra !== undefined) Object.assign(error, extra);
  return { ok: false, error };
}

function isVersionDirName(name) {
  return /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(name);
}

// ---------------------------------------------------------------------------
// install: preflight verdict plus lock conflict, one install at a time
// ---------------------------------------------------------------------------

// A second install request while the single install lock is held is rejected,
// never queued (US9). The lock is a fact the manager entrypoint owns (route C
// owns I/O); this decision just says which request may proceed.
function lockDecision(lockState, request = {}) {
  const heldBy = lockState && typeof lockState === 'object' ? lockState.heldBy : null;
  const requestId = typeof request.id === 'string' && request.id ? request.id : null;
  if (heldBy !== null && heldBy !== undefined && heldBy !== requestId) {
    return {
      ok: false,
      verdict: 'rejected',
      reason: DECISION_ERROR_CODES.LOCK_CONFLICT,
      heldBy,
      message: 'another install request already holds the single install lock; rerun after it settles',
    };
  }
  return { ok: true, verdict: 'accepted', lockOwner: requestId, reason: null };
}

// installDecision(volumeSnapshot, policyOutput, lockState).
//
// Preflight verdicts reuse the policy module's preflight (owner/space/
// registry, ordered and short-circuiting) — do not re-derive version policy.
// The stale-root-owned branch is layered on top: a volume whose owner is not
// the expected uid is fail-closed for install AND is the trigger for the
// reset relocation branch (US17). Interrupts and timeouts are promised only
// as rerun-install-to-recover (US10): no cancellation semantics, no resumable
// state machine — the contract is a single promise, not a lifecycle.
function installDecision(volumeSnapshot = {}, policyOutput = {}, lockState = null) {
  const lock = lockDecision(lockState, policyOutput);
  if (!lock.ok) {
    return {
      ok: false,
      stage: 'lock',
      lock,
      error: { code: DECISION_ERROR_CODES.LOCK_CONFLICT, message: lock.message },
      recovery: 'rerun-install-to-recover',
    };
  }
  const preflight = policyPreflight(volumeSnapshot);
  if (!preflight.ok) {
    const reason = preflight.error && preflight.error.reason;
    const staleRootOwned =
      reason === PREFLIGHT_REASONS.OWNER &&
      volumeSnapshot.ownerUid !== undefined &&
      volumeSnapshot.ownerUid !== (volumeSnapshot.expectedUid ?? DEFAULT_EXPECTED_UID);
    const verdict = {
      ok: false,
      stage: 'preflight',
      preflight,
      error: {
        code: POLICY_ERROR_CODES.PREFLIGHT_FAILED,
        reason,
        message: preflight.error && preflight.error.message,
      },
      recovery: 'fix-volume',
    };
    if (staleRootOwned) {
      verdict.branch = FAILURE_BRANCHES.STALE_ROOT_OWNED;
      verdict.relocationHint = RETIRED_DIR_NAME;
    }
    return verdict;
  }
  return { ok: true, stage: 'cleared', preflight, lock, error: null, recovery: null };
}

// ---------------------------------------------------------------------------
// rollback: flip the 'current' symlink back, keep the failed version on disk
// ---------------------------------------------------------------------------

// rollbackDecision(healthCheckResult, volumeSnapshot).
//
// Post-install health check failure flips 'current' back to the previous
// version (US4): a seconds-level symlink operation, no download, no registry
// access (US7). The failed new version directory stays on the volume so it
// can be inspected and retried (US5); the rollback target is protected from
// the pre-install cleanup via the policy module's cleanupPlan, which keeps
// current's target and its immediate predecessor (US8, #10 steady-state of
// two old versions, US6).
//
// healthCheckResult: { ok: boolean, reportedAt?: string }
// volumeSnapshot: the policy module's volume shape plus optional version mtimes
// ({ name, mtimeMs } under versions/); 'current' target resolves through the
// same helper the policy module uses.
function rollbackDecision(healthCheckResult = {}, volumeSnapshot = {}) {
  if (healthCheckResult.ok === undefined || healthCheckResult.ok === null) {
    return failure(DECISION_ERROR_CODES.HEALTH_CHECK_UNREPORTED, 'the post-install health check result is missing');
  }
  if (healthCheckResult.ok !== false) {
    return { ok: true, flip: null, reason: null, message: 'health check passed; no rollback needed' };
  }

  const currentTarget =
    typeof volumeSnapshot.currentTarget === 'string' && volumeSnapshot.currentTarget
      ? volumeSnapshot.currentTarget
      : null;
  const pendingVersion =
    typeof volumeSnapshot.pendingVersion === 'string' && volumeSnapshot.pendingVersion
      ? volumeSnapshot.pendingVersion
      : null;

  // Candidates: every version directory on the volume except the pending one
  // (the failed install) and except current's own target (nothing to flip to
  // when the running version is already the only other one).
  const entries = Array.isArray(volumeSnapshot.versions) ? volumeSnapshot.versions : [];
  const seen = new Set();
  const candidates = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    if (!isVersionDirName(entry.name)) continue;
    if (entry.name === pendingVersion) continue;
    if (currentTarget && entry.name === path.basename(currentTarget)) continue;
    const hasMtime = typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs);
    candidates.push({ name: entry.name, mtimeMs: hasMtime ? entry.mtimeMs : null });
  }

  if (candidates.length === 0) {
    return failure(DECISION_ERROR_CODES.ROLLBACK_NO_TARGET, 'no previous version directory is available to flip back to');
  }

  // The immediate predecessor is the newest old version by mtime; unorderable
  // directories (no mtime) never become the target — ambiguity is surfaced,
  // not guessed.
  const ordered = candidates
    .filter(candidate => candidate.mtimeMs !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const unordered = candidates.filter(candidate => candidate.mtimeMs === null);
  if (ordered.length === 0) {
    return failure(
      DECISION_ERROR_CODES.ROLLBACK_TARGET_AMBIGUOUS,
      'no rollback candidate has a usable mtime; target cannot be determined'
    );
  }
  const target = ordered[0].name;
  const warnings = unordered.map(
    candidate => 'version directory ' + candidate.name + ' has no usable mtime and cannot be a rollback target'
  );

  // The failed pending version is kept, not deleted (US5); the cleanup plan
  // for any subsequent install excludes it through pendingVersion.
  return {
    ok: true,
    flip: { from: currentTarget ?? null, to: target },
    keepFailedVersion: pendingVersion,
    reason: 'post-install-health-check-failed',
    warnings,
  };
}

// ---------------------------------------------------------------------------
// reset: move-aside relocation plan, never delete, session data untouched
// ---------------------------------------------------------------------------

// Which top-level entries of the install volume a factory reset relocates.
// Only versioned content moves; the shared npm cache, the log directory and
// any prior retired snapshots are infrastructure, not install content, and
// are left in place (US13/US14: mount data is never wiped, session data in
// ~/.dsh and the workspace volume is never touched).
function relocatableEntries(volumeLayout = {}) {
  const entries = Array.isArray(volumeLayout.entries) ? volumeLayout.entries : [];
  const infrastructure = new Set([RETIRED_DIR_NAME, LOGS_DIR_NAME, NPM_CACHE_DIR_NAME]);
  const plan = { relocate: [], keepInPlace: [] };
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    if (infrastructure.has(entry.name)) {
      plan.keepInPlace.push(entry.name);
    } else {
      plan.relocate.push(entry.name);
    }
  }
  plan.relocate.sort();
  plan.keepInPlace.sort();
  return plan;
}

// resetDecision(volumeLayout, profileLinks, timestamp).
//
// A factory reset moves the install volume's versioned content into a
// .retired/<timestamp>/ directory and never deletes anything (US13/US14).
// Profile plugin links that point into relocated subdirectories are updated
// in the same decision that moves the plugin, so links do not dangle
// (US15); out-of-repo plugins (e.g. dsh-mobile-bridge) are left untouched
// (US16).
//
// volumeLayout: { entries: [{name, kind?, ownerUid?}], ownerUid, expectedUid }
// profileLinks: [{ profile, target }]  — target is an absolute path on the
//   install volume (e.g. /opt/dsh/plugins/dsh-browser-desktop)
// timestamp: an opaque string supplied by the caller (the entrypoint owns the
//   clock), e.g. '20261025T040000Z'; it is used verbatim as the retired root
//   subdirectory name so the plan stays pure and testable.
function resetDecision(volumeLayout = {}, profileLinks = [], timestamp) {
  const expectedUid =
    volumeLayout.expectedUid !== undefined ? volumeLayout.expectedUid : DEFAULT_EXPECTED_UID;
  const ownerUid = volumeLayout.ownerUid;

  const staleBranch =
    ownerUid !== undefined && ownerUid !== null && ownerUid !== expectedUid;

  return { ...relocationPlan(volumeLayout, profileLinks, timestamp, staleBranch), ok: true };
}

function relocationPlan(volumeLayout, profileLinks, timestamp, staleBranch) {
  const layoutPlan = relocatableEntries(volumeLayout);
  const retiredRoot = '.retired/' + String(timestamp ?? '0');
  const relocations = layoutPlan.relocate.map(name => ({
    from: name,
    to: retiredRoot + '/' + name,
  }));

  // Profile link updates: any link target that points inside a relocated
  // entry is re-pointed at the same sub-path under the retired root, so the
  // link stays valid after the move (US15). Links to out-of-repo or
  // keep-in-place locations are untouched (US16).
  const relocatedNames = new Set(layoutPlan.relocate);
  const linkUpdates = [];
  const untouchedLinks = [];
  for (const link of Array.isArray(profileLinks) ? profileLinks : []) {
    if (!link || typeof link.target !== 'string') {
      untouchedLinks.push({ profile: link ? (link.profile ?? null) : null, target: null });
      continue;
    }
    const targetPath = link.target.replace(/\/+$/, '');
    const segments = targetPath.split('/');
    const first = segments.find(segment => segment && segment !== '');
    if (first && relocatedNames.has(first)) {
      const rest = segments.slice(segments.indexOf(first) + 1).join('/');
      linkUpdates.push({
        profile: link.profile ?? null,
        from: link.target,
        to: rest ? retiredRoot + '/' + rest : retiredRoot,
      });
    } else {
      untouchedLinks.push({ profile: link.profile ?? null, target: link.target });
    }
  }

  return {
    ok: true,
    branch: staleBranch ? FAILURE_BRANCHES.STALE_ROOT_OWNED : null,
    retiredRoot,
    relocations,
    keepInPlace: layoutPlan.keepInPlace,
    linkUpdates,
    untouchedLinks,
    deletes: [],
    message: staleBranch
      ? 'stale (not-owned-by-us) install content is relocated aside, never deleted'
      : 'factory reset moves install content aside; session data and workspace volumes are never touched',
  };
}

// ---------------------------------------------------------------------------
// log rotation: keep the 10 newest install logs, drop the oldest beyond that
// ---------------------------------------------------------------------------

// logRotation(logsListing).
//
// Install logs live in the volume logs/ directory (US11): a failed install on
// a read-only root still leaves a diagnosis. At most the 10 most recent are
// kept; the oldest beyond that are dropped (US12), so the volume does not grow
// without bound. Listing entries without a usable mtime are kept, never
// dropped — an undatable log is not guessable-oldest.
function logRotation(logsListing = {}) {
  const entries = Array.isArray(logsListing.entries) ? logsListing.entries : [];
  const warnings = Array.isArray(logsListing.warnings) ? [...logsListing.warnings] : [];
  const dated = [];
  const undated = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    const hasMtime = typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs);
    if (hasMtime) {
      dated.push({ name: entry.name, mtimeMs: entry.mtimeMs });
    } else {
      undated.push({ name: entry.name });
    }
  }
  dated.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  );

  const dropCount = Math.max(0, dated.length - KEEP_INSTALL_LOGS);
  const keepDated = dated.slice(0, dated.length - dropCount);
  const drop = dated.slice(dated.length - dropCount).map(entry => entry.name);
  const keep = [...keepDated.map(entry => entry.name), ...undated.map(entry => entry.name)].sort();
  for (const entry of undated) {
    warnings.push('log ' + entry.name + ' has no usable mtime and is always kept, never dropped');
  }
  return { keep, drop: drop.sort(), keepLimit: KEEP_INSTALL_LOGS, warnings };
}

// ---------------------------------------------------------------------------
// Fact-collection adapters (fs lives here only)
// ---------------------------------------------------------------------------

// collectLogsListing(root): the logs/ directory of the install volume, as a
// dated entry listing ready for logRotation().
async function collectLogsListing(root = '/opt/dsh') {
  const logsDir = path.join(root, LOGS_DIR_NAME);
  const warnings = [];
  let names = [];
  try {
    names = await fs.promises.readdir(logsDir);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      warnings.push('readdir of ' + logsDir + ' failed (' + (error.code ?? error.message) + ')');
    }
  }
  const entries = [];
  for (const name of names) {
    try {
      const info = await fs.promises.stat(path.join(logsDir, name));
      entries.push({ name, mtimeMs: info.mtimeMs });
    } catch (error) {
      entries.push({ name, mtimeMs: null });
      warnings.push('stat of ' + name + ' failed (' + (error.code ?? error.message) + '); the log is kept, never dropped');
    }
  }
  return { entries, warnings };
}

module.exports = {
  DECISION_ERROR_CODES,
  DECISION_FAILURE,
  FAILURE_BRANCHES,
  KEEP_INSTALL_LOGS,
  LOGS_DIR_NAME,
  NPM_CACHE_DIR_NAME,
  RETIRED_DIR_NAME,
  VERSIONED_ENTRY_NAMES,
  collectLogsListing,
  installDecision,
  logRotation,
  lockDecision,
  policyCleanupPlan,
  policyPreflight,
  relocationPlan,
  relocatableEntries,
  resetDecision,
  rollbackDecision,
};
