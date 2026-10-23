#!/usr/bin/env node
'use strict';

// admin version policy: pure decision module plus a thin fact-collection
// adapter (spec #14; decision #10; ADR-0002).
//
// The pure functions below never touch fs, network or child processes. They
// consume explicit snapshots and return plain data:
//
//   listRows(facts)        packuments + pin        -> sorted version rows
//   installSpecs(facts)    packuments + pin + v    -> exact name@version specs
//   cleanupPlan(volume, v) volume snapshot + v     -> directory removal plan
//   preflight(volume)      owner/space/registry    -> short-circuiting checks
//
// The adapters at the bottom only collect facts: the three packuments (fetch
// injectable), the npmrc text, the read-only pin artifact and a volume
// snapshot (versions/* mtimes, `current` realpath, owner uid, writability,
// statfs free bytes). HTTP routes, npm execution, install layout/merge and
// flip/rollback belong to #6/#5 and are deliberately absent.
//
// The floor anchor is read from the image's read-only pin artifact
// (DSH_PIN env seam). DSH_VERSION is operator-overridable and must never be
// used as the policy anchor.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEEP_OLD_VERSIONS = 2;
const MIN_FREE_BYTES = 1_500_000_000; // 1.5 GB, decimal (not GiB)
const DEFAULT_EXPECTED_UID = 1000;
const PIN_ARTIFACT_NAME = 'DSH_PIN';
const DSH_PACKAGE = '@deepseek-ai/dsh';
const BROWSER_USE_PACKAGE = '@deepseek-ai/dsh-browser-use';
const PLAYWRIGHT_MCP_PACKAGE = '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp';
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/';
const DIST_TAG_NAMES = ['latest', 'next', 'alpha'];

// DSH versions are three numeric segments with an optional
// `-(alpha|beta|rc).N` pre-release marker. Anything else cannot be ordered,
// classified or cleaned up; packument entries that fail this shape are
// omitted from the list and volume entries that fail it are never candidates.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
const CHANNEL_RANK = { alpha: 0, beta: 1, rc: 2 };

const ERROR_CODES = Object.freeze({
  REGISTRY_UNREACHABLE: 'registry-unreachable',
  PIN_MISSING: 'pin-missing',
  VERSION_NOT_FOUND: 'version-not-found',
  PAIRING_MISSING: 'pairing-missing',
  AUTH_UNSUPPORTED: 'auth-unsupported',
  PREFLIGHT_FAILED: 'preflight-failed',
});

const PREFLIGHT_REASONS = Object.freeze({
  OWNER: 'owner',
  SPACE: 'space',
  REGISTRY: 'registry',
});

// ---------------------------------------------------------------------------
// Pure decision functions
// ---------------------------------------------------------------------------

function failure(code, message, detail) {
  const error = { code, message };
  if (detail !== undefined) error.detail = detail;
  return { ok: false, error };
}

function policyError(code, message, extra) {
  const error = new Error(`${code}: ${message}`);
  error.name = 'AdminVersionPolicyError';
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    channel: match[4] ?? 'stable',
    preRelease: match[5] === undefined ? null : Number(match[5]),
  };
}

// Explicit total order (spec: three numeric segments; alpha < beta < rc then
// the numeric marker; stable beats a pre-release of the same triple). This is
// the list filter and "highest version" order; registry publication order is
// never consulted.
function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) throw new TypeError('compareVersions requires parseable DSH versions');
  for (const segment of ['major', 'minor', 'patch']) {
    if (left[segment] !== right[segment]) return left[segment] - right[segment];
  }
  if (left.preRelease === null && right.preRelease === null) return 0;
  if (left.preRelease === null) return 1;
  if (right.preRelease === null) return -1;
  if (CHANNEL_RANK[left.channel] !== CHANNEL_RANK[right.channel]) {
    return CHANNEL_RANK[left.channel] - CHANNEL_RANK[right.channel];
  }
  return left.preRelease - right.preRelease;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function versionsOf(packument) {
  if (!packument || typeof packument !== 'object' || Array.isArray(packument)) return null;
  const versions = packument.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return null;
  return versions;
}

function distTagsOf(packument) {
  const tags = packument && typeof packument === 'object' ? packument['dist-tags'] : null;
  return tags && typeof tags === 'object' && !Array.isArray(tags) ? tags : {};
}

// Rows are sorted newest-first for display only; the install gate below is an
// exact string membership check, so ordering can never widen the set.
function listRows(facts = {}) {
  const dshVersions = versionsOf(facts.dsh);
  const browserUseVersions = versionsOf(facts.browserUse);
  const playwrightMcpVersions = versionsOf(facts.playwrightMcp);
  if (!dshVersions || !browserUseVersions || !playwrightMcpVersions) {
    return failure(ERROR_CODES.REGISTRY_UNREACHABLE, 'one or more registry packuments are unavailable');
  }
  if (Object.keys(dshVersions).length === 0) {
    return failure(ERROR_CODES.REGISTRY_UNREACHABLE, 'the dsh packument lists no versions');
  }

  const pin = facts.pin;
  const parsedPin = parseVersion(pin);
  // The pin must itself exist in the registry: a lagging private mirror or a
  // yanked upstream version is an explicit error, never an empty list.
  if (!parsedPin || !hasOwn(dshVersions, pin)) {
    return failure(ERROR_CODES.PIN_MISSING, 'the pinned version is not present in the dsh packument');
  }

  const distTags = distTagsOf(facts.dsh);
  const rows = [];
  for (const version of Object.keys(dshVersions)) {
    const parsed = parseVersion(version);
    if (!parsed) continue;
    if (compareVersions(parsed, parsedPin) < 0) continue;
    const paired = hasOwn(browserUseVersions, version) && hasOwn(playwrightMcpVersions, version);
    rows.push({
      version,
      prerelease: parsed.channel,
      distTags: DIST_TAG_NAMES.filter(tag => distTags[tag] === version),
      tested: version === pin,
      installable: paired,
      reason: paired ? null : ERROR_CODES.PAIRING_MISSING,
    });
  }
  rows.sort((left, right) => compareVersions(right.version, left.version));
  return { ok: true, rows };
}

// Install specs are always exact versions. Membership in the constructed list
// rejects `latest`, dist-tag names, ranges and anything below the pin before
// any npm command could see it.
function installSpecs(input = {}) {
  const listed = listRows(input);
  if (!listed.ok) return listed;
  const row = listed.rows.find(candidate => candidate.version === input.version);
  if (!row) {
    return failure(ERROR_CODES.VERSION_NOT_FOUND, 'the requested version is not in the allowed install set');
  }
  if (!row.installable) {
    return failure(ERROR_CODES.PAIRING_MISSING, 'the same-version browser-use pairing is missing');
  }
  return {
    ok: true,
    version: row.version,
    tested: row.tested,
    specs: [
      `${DSH_PACKAGE}@${row.version}`,
      `${BROWSER_USE_PACKAGE}@${row.version}`,
      `${PLAYWRIGHT_MCP_PACKAGE}@${row.version}`,
    ],
  };
}

function isCurrentTarget(name, currentTarget, versionsDir) {
  if (!name || !currentTarget) return false;
  if (path.isAbsolute(currentTarget)) {
    if (!versionsDir) return false;
    return path.resolve(currentTarget) === path.resolve(versionsDir, name);
  }
  return currentTarget === name || path.basename(currentTarget) === name;
}

// Keep `current` + KEEP_OLD_VERSIONS-1 old versions before an install; the
// pending version becomes current on flip, so counting it as the post-flip
// current leaves exactly KEEP_OLD_VERSIONS old directories. The newest old
// directory is the rollback anchor and is never removed. Directories without
// a usable mtime cannot be ordered and are excluded with a warning.
function cleanupPlan(volume = {}, pendingVersion) {
  const versionsDir = typeof volume.versionsDir === 'string' ? volume.versionsDir : null;
  const currentTarget = typeof volume.currentTarget === 'string' && volume.currentTarget ? volume.currentTarget : null;
  const warnings = Array.isArray(volume.warnings) ? [...volume.warnings] : [];
  const entries = Array.isArray(volume.versions) ? volume.versions : [];

  const installed = new Set();
  const mtimeByName = new Map();
  const deletable = [];
  const seen = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (!VERSION_PATTERN.test(entry.name)) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    installed.add(entry.name);
    if (isCurrentTarget(entry.name, currentTarget, versionsDir)) continue;
    const hasMtime = typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs);
    if (!hasMtime) {
      warnings.push(`version directory ${entry.name} has no usable mtime and is excluded from the cleanup plan`);
      continue;
    }
    mtimeByName.set(entry.name, entry.mtimeMs);
    deletable.push({ name: entry.name, mtimeMs: entry.mtimeMs });
  }

  if (typeof pendingVersion === 'string' && pendingVersion) installed.add(pendingVersion);

  // The directory set after the flip: pending is current, everything else
  // (including the previous current) is an old version.
  const oldAfterFlip = [...installed].filter(name => name !== pendingVersion);
  let protectedName = null;
  for (const name of oldAfterFlip) {
    if (isCurrentTarget(name, currentTarget, versionsDir)) continue;
    if (!mtimeByName.has(name)) continue;
    if (protectedName === null || mtimeByName.get(name) > mtimeByName.get(protectedName)) protectedName = name;
  }

  const removeCount = Math.max(0, oldAfterFlip.length - KEEP_OLD_VERSIONS);
  const candidates = deletable
    .filter(candidate => candidate.name !== pendingVersion)
    .filter(candidate => !isCurrentTarget(candidate.name, currentTarget, versionsDir))
    .filter(candidate => candidate.name !== protectedName)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const remove = candidates.slice(0, removeCount).map(candidate => candidate.name);
  if (remove.length < removeCount) {
    warnings.push(`cleanup cannot reach ${KEEP_OLD_VERSIONS} old versions because ${removeCount - remove.length} candidate directories are missing a usable mtime`);
  }

  const keep = [...installed]
    .filter(name => !remove.includes(name))
    .sort((left, right) => {
      const leftVersion = parseVersion(left);
      const rightVersion = parseVersion(right);
      if (leftVersion && rightVersion) return compareVersions(rightVersion, leftVersion);
      return left < right ? -1 : left > right ? 1 : 0;
    });

  return { pendingVersion: pendingVersion ?? null, remove, keep, warnings };
}

function freeBytesAsNumber(value) {
  const normalized = typeof value === 'bigint' ? Number(value) : value;
  return typeof normalized === 'number' && Number.isFinite(normalized) ? normalized : null;
}

// Ordered, short-circuiting preflight: owner+write, then space, then registry.
// `expectedUid` is injectable because CI runners are not uid 1000.
function preflight(facts = {}) {
  const expectedUid = facts.expectedUid ?? DEFAULT_EXPECTED_UID;
  const warnings = Array.isArray(facts.warnings) ? [...facts.warnings] : [];
  const checks = [];
  const failed = (reason, message) => ({
    ok: false,
    error: { code: ERROR_CODES.PREFLIGHT_FAILED, reason, message },
    checks,
    warnings,
  });

  checks.push({ name: PREFLIGHT_REASONS.OWNER, ok: facts.ownerUid === expectedUid && facts.writable === true });
  if (!checks[checks.length - 1].ok) {
    return failed(PREFLIGHT_REASONS.OWNER, `the volume owner must be uid ${expectedUid} and the volume must be writable`);
  }

  const freeBytes = freeBytesAsNumber(facts.freeBytes);
  checks.push({ name: PREFLIGHT_REASONS.SPACE, ok: freeBytes !== null && freeBytes >= MIN_FREE_BYTES });
  if (!checks[checks.length - 1].ok) {
    return failed(PREFLIGHT_REASONS.SPACE, `at least ${MIN_FREE_BYTES} free bytes (1.5 GB) are required`);
  }

  checks.push({ name: PREFLIGHT_REASONS.REGISTRY, ok: facts.registryReachable === true });
  if (!checks[checks.length - 1].ok) {
    return failed(PREFLIGHT_REASONS.REGISTRY, 'the registry is not reachable');
  }

  return { ok: true, checks, warnings };
}

// ---------------------------------------------------------------------------
// npmrc adapter (pure parsing; the caller supplies the text and env)
// ---------------------------------------------------------------------------

function expandEnv(value, env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => (env && env[name] !== undefined ? String(env[name]) : ''));
}

function stripQuotes(value) {
  const text = String(value).trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseNpmrc(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    entries.push({ key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() });
  }
  return entries;
}

// npm nerf-darts look like `//host[:port]/<path>/:_authToken`. Any other
// credential form (`_auth`, `_password`, `username`, unscoped `_authToken`)
// fails closed instead of being silently approximated.
function credentialKey(key) {
  if (!key.startsWith('//')) {
    if (key === '_auth' || key === '_password' || key === 'username' || key === '_authToken') {
      return { kind: 'unsupported', scope: null, scopeHost: null, scopePath: null };
    }
    return null;
  }
  const suffix = [':_authToken', ':_auth', ':_password', ':username'].find(candidate => key.endsWith(candidate));
  if (!suffix) return null;
  const scope = key.slice(2, -suffix.length);
  const separator = scope.indexOf('/');
  const scopeHost = separator === -1 ? scope : scope.slice(0, separator);
  const scopePath = separator === -1 ? '' : scope.slice(separator);
  return {
    kind: suffix === ':_authToken' ? 'bearer' : 'unsupported',
    scope,
    scopeHost,
    scopePath,
  };
}

function normalizeHost(value, protocol) {
  try {
    const parsed = new URL(`${protocol}//${value}`);
    const defaultPort = protocol === 'https:' ? '443' : '80';
    return parsed.port && parsed.port !== defaultPort ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return null;
  }
}

function pathMatches(registryPath, scopePath) {
  if (!scopePath) return true;
  return registryPath === scopePath || registryPath.startsWith(scopePath) || (scopePath.endsWith('/') && `${registryPath}/`.startsWith(scopePath));
}

function resolveNpmrcAuth({ npmrcText = null, registryUrl = DEFAULT_REGISTRY_URL, env = process.env } = {}) {
  let registry;
  try {
    registry = new URL(registryUrl);
  } catch {
    return failure(ERROR_CODES.REGISTRY_UNREACHABLE, 'the registry URL is not a valid URL');
  }
  if (registry.protocol !== 'https:' && registry.protocol !== 'http:') {
    return failure(ERROR_CODES.REGISTRY_UNREACHABLE, 'the registry URL must use http or https');
  }
  const registryHost = normalizeHost(registry.host, registry.protocol);
  const registryPath = registry.pathname || '/';

  const parsed = parseNpmrc(npmrcText).map(entry => ({ ...entry, credential: credentialKey(entry.key) }));
  const relevant = credential => {
    if (!credential) return false;
    if (!credential.scopeHost) return true; // unscoped forms apply to the configured registry
    return normalizeHost(credential.scopeHost, registry.protocol) === registryHost && pathMatches(registryPath, credential.scopePath);
  };

  if (parsed.some(entry => entry.credential && entry.credential.kind === 'unsupported' && relevant(entry.credential))) {
    return failure(ERROR_CODES.AUTH_UNSUPPORTED, 'npmrc credentials other than a scoped bearer _authToken are unsupported');
  }

  let best = null;
  for (const entry of parsed) {
    const credential = entry.credential;
    if (!credential || credential.kind !== 'bearer' || !credential.scopeHost) continue;
    if (normalizeHost(credential.scopeHost, registry.protocol) !== registryHost) continue;
    if (!pathMatches(registryPath, credential.scopePath)) continue;
    if (best === null || credential.scopePath.length > best.scopePath.length) best = { ...credential, value: entry.value };
  }
  if (best === null) return { ok: true, token: null };

  const token = stripQuotes(expandEnv(best.value, env));
  if (!token) {
    return failure(ERROR_CODES.AUTH_UNSUPPORTED, 'the matched npmrc _authToken expands to an empty value');
  }
  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Fact-collection adapters (fs/network live here only)
// ---------------------------------------------------------------------------

function registryUrlFromEnv(env = process.env) {
  const value = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY_URL;
  return String(value).trim();
}

function packumentUrl(registryUrl, pkg) {
  const base = new URL(registryUrl);
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  base.search = '';
  base.hash = '';
  return new URL(encodeURIComponent(pkg), base).toString();
}

// Read the build-time pin from the image's read-only artifact seam. The
// operator-overridable DSH_VERSION is intentionally never consulted.
function readPin({ env = process.env } = {}) {
  const value = env[PIN_ARTIFACT_NAME];
  if (typeof value !== 'string' || !value.trim()) {
    throw policyError(ERROR_CODES.PIN_MISSING, `the read-only pin artifact ${PIN_ARTIFACT_NAME} is missing`);
  }
  return value.trim();
}

async function readNpmrcText({ env = process.env, home = os.homedir() } = {}) {
  const file = env.NPM_CONFIG_USERCONFIG || path.join(home, '.npmrc');
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw policyError(ERROR_CODES.AUTH_UNSUPPORTED, `cannot read npmrc at ${file}`);
  }
}

async function fetchPackument({ pkg, registryUrl = DEFAULT_REGISTRY_URL, fetchImpl = globalThis.fetch, token = null } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw policyError(ERROR_CODES.REGISTRY_UNREACHABLE, 'no fetch implementation is available');
  }
  let url;
  try {
    url = packumentUrl(registryUrl, pkg);
  } catch {
    throw policyError(ERROR_CODES.REGISTRY_UNREACHABLE, 'the registry URL is not a valid URL');
  }
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    throw policyError(ERROR_CODES.REGISTRY_UNREACHABLE, `registry request failed for ${pkg}`);
  }
  if (!response || !response.ok) {
    throw policyError(ERROR_CODES.REGISTRY_UNREACHABLE, `registry did not return a packument for ${pkg}`);
  }
  try {
    return await response.json();
  } catch {
    throw policyError(ERROR_CODES.REGISTRY_UNREACHABLE, `registry returned an unreadable packument for ${pkg}`);
  }
}

async function collectRegistryFacts({
  registryUrl = registryUrlFromEnv(),
  npmrcText,
  env = process.env,
  home = os.homedir(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const text = npmrcText === undefined ? await readNpmrcText({ env, home }) : npmrcText;
  const auth = resolveNpmrcAuth({ npmrcText: text, registryUrl, env });
  if (!auth.ok) throw policyError(auth.error.code, auth.error.message);
  const [dsh, browserUse, playwrightMcp] = await Promise.all([
    fetchPackument({ pkg: DSH_PACKAGE, registryUrl, fetchImpl, token: auth.token }),
    fetchPackument({ pkg: BROWSER_USE_PACKAGE, registryUrl, fetchImpl, token: auth.token }),
    fetchPackument({ pkg: PLAYWRIGHT_MCP_PACKAGE, registryUrl, fetchImpl, token: auth.token }),
  ]);
  return { dsh, browserUse, playwrightMcp };
}

async function collectVolumeSnapshot({ root = '/opt/dsh' } = {}) {
  const versionsDir = path.join(root, 'versions');
  const currentPath = path.join(root, 'current');
  const warnings = [];
  let ownerUid = null;
  let writable = false;
  let freeBytes = null;
  let currentTarget = null;
  const versions = [];

  try {
    const info = await fs.promises.stat(root);
    ownerUid = info.uid;
  } catch (error) {
    warnings.push(`stat of ${root} failed (${error.code ?? error.message}); the owner check will fail`);
  }

  try {
    await fs.promises.access(root, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  try {
    const stats = await fs.promises.statfs(root, { bigint: true });
    freeBytes = Number(stats.bsize * stats.bavail);
  } catch (error) {
    warnings.push(`statfs of ${root} failed (${error.code ?? error.message}); the space check will fail`);
  }

  try {
    currentTarget = await fs.promises.realpath(currentPath);
  } catch (error) {
    warnings.push(`realpath of ${currentPath} failed (${error.code ?? error.message}); no current target is excluded`);
  }

  let names = [];
  try {
    names = await fs.promises.readdir(versionsDir);
  } catch (error) {
    warnings.push(`readdir of ${versionsDir} failed (${error.code ?? error.message}); the cleanup plan has no candidates`);
  }

  for (const name of names) {
    try {
      const info = await fs.promises.stat(path.join(versionsDir, name));
      versions.push({ name, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() });
    } catch (error) {
      versions.push({ name, mtimeMs: null, isDirectory: null });
      warnings.push(`stat of ${name} failed (${error.code ?? error.message}); it is excluded from the cleanup plan`);
    }
  }

  return { root, versionsDir, versions, currentTarget, ownerUid, writable, freeBytes, warnings };
}

module.exports = {
  BROWSER_USE_PACKAGE,
  DEFAULT_EXPECTED_UID,
  DEFAULT_REGISTRY_URL,
  DSH_PACKAGE,
  ERROR_CODES,
  KEEP_OLD_VERSIONS,
  MIN_FREE_BYTES,
  PIN_ARTIFACT_NAME,
  PLAYWRIGHT_MCP_PACKAGE,
  PREFLIGHT_REASONS,
  cleanupPlan,
  collectRegistryFacts,
  collectVolumeSnapshot,
  fetchPackument,
  installSpecs,
  listRows,
  packumentUrl,
  policyError,
  preflight,
  readNpmrcText,
  readPin,
  registryUrlFromEnv,
  resolveNpmrcAuth,
};
