# DSH launch-token lifecycle, version stability, and proxy failure modes

Research note for wayfinder ticket #3. It answers one question: if a Node proxy sits in front of
`dsh --profile web` and must turn the printed launch token into a browser cookie server-side, what
exactly is that token, how stable is it across official DSH versions, and what breaks?

- **Date:** 2026-10-20
- **Verified against:** `@deepseek-ai/dsh@0.2.1-rc.2` (npm `latest` and `next` on this date; the
  repo's default in `Dockerfile:6`), plus sixteen versions spanning `0.0.1-rc.1` to `0.2.1-rc.2`
  (every boundary where the token, the printed line, or the web flags changed), inspected from npm
  tarballs.
- **Method:** source reading of the installed tree at `/opt/dsh` and of the tagged upstream source,
  plus a live probe of a throwaway `dsh --profile web` process on a temporary `DSH_HOME` (evidence
  in [§10](#10-live-evidence-log)). No production code was written.

## Short answer

- The token is **32 random bytes, base64url-encoded (43 characters), generated per process** when
  Connection activates, retained across Connection hot reloads, **never persisted**, and exposed
  only through the startup URL line `dsh web: <root>/?token=<token>` on **stdout**.
  There is **no environment variable and no config field** that fixes, supplies, or reads the
  token ([browser-auth.ts L61–L67][ba-token]).
- The exchange is narrow but has been stable since it was introduced: **`GET /?token=<token>`**
  with exactly one `token` parameter (other query parameters are ignored), answered with
  **`303 Location: ./`** and an authority-bound signed cookie; every other shape gets a minimal
  **401**, except a stale token accompanied by a valid cookie, which still redirects cleanly
  ([browser-auth.ts L263–L305][ba-exchange]).
- **The token rotates on every restart; the cookie does not.** The HMAC signing secret lives in
  `$DSH_HOME/.credentials.yaml` and cookies are valid for `cookieMaxAgeDays` (default 30) across
  restarts on the same authority. This is an intentional design decision, not an accident
  ([token note L17–L21][note], [connection README L43][conn-cookie]).
- **The printed line is not stable across the version range the admin feature can select.** Versions
  before `0.1.2-alpha.2` print no token at all; `0.1.2-alpha.2` through `0.2.1-alpha.1` append a
  second tokenized `(LAN: …)` URL when a LAN address exists; `0.2.1-alpha.2` removes it and adds TLS
  and a stderr warning that reuses the `dsh web:` prefix. Upstream publishes no explicit
  compatibility contract for the line text; its README describes the line as a *readiness signal*,
  not an API ([web-app README L113][wa-readiness]).
- **The subtle killer is cookie authority, not token parsing.** The cookie name and payload bind the
  request's **verbatim `Host` header** (hostname *and* port; scheme too when the listener serves
  TLS). A server-side exchange that dials the backend with a different `Host` than the browser sends
  will mint a cookie the browser can carry but DSH will never accept — permanent 401
  ([browser-auth.ts L78–L88][ba-audience], [connection README L43][conn-cookie]).

## 1. Where the token comes from

`BrowserAuth` owns both the process token and the persistent cookie secret
([browser-auth.ts L14–L20][ba-consts]):

| Fact | Detail | Source |
|---|---|---|
| Generation | `randomBytes(32)` → base64url, 43 chars, URL-safe, no padding | [browser-auth.ts L61–L67][ba-token] |
| Scope | One token per **root application context**, memoized in a `WeakMap`; Connection hot reload keeps it, a new process gets a new one | [browser-auth.ts L61–L67][ba-token], [connection index.ts L136–L140][conn-create] |
| Lifetime | Until the process exits. Not persisted, not written to disk, no rotation endpoint | [token note L21][note] |
| Readability | Only via `authenticatedUrl(baseUrl)`, which calls `url.searchParams.set('token', …)` | [browser-auth.ts L244–L248][ba-url] |
| Print site | `web-app` glue plugin, `console.log` (stdout), gated by `config.printUrl` | [web-app index.ts L225–L239][wa-print] |
| Print timing | After the Loader tree settles and the required-startup audit passes; one print per root (`ANNOUNCED_ROOTS`) | [web-app index.ts L218–L246][wa-print], [web-app README L113][wa-readiness] |
| Advertised root | `config.publicUrl` when set (since `0.2.1-alpha.1`), otherwise `getOrigin()` = `protocol//bindHost:listenedPort` | [web-app index.ts L200–L202][wa-root], [web-server doc L84][ws-doc] |
| Mount preservation | `new URL(baseUrl)` + `searchParams.set` keeps the path, so `https://app.example/ui/` prints as `https://app.example/ui/?token=…` | [browser-auth.ts L244–L248][ba-url], [public-url.ts L20–L38][pub-url] |
| Query shape | `publicUrl` rejects `?` and `#`, so the printed URL carries exactly one authentication parameter (`token`); other parameters are tolerated by the exchange | [public-url.ts L23–L25][pub-url], [browser-auth.ts L266–L270][ba-exchange] |

### The `dsh web:` lines

A parser that keys only on the `dsh web:` prefix will false-positive. In `0.2.1-rc.2`:

| Stream | Text | When |
|---|---|---|
| stdout | `dsh web: <root>/?token=<43 chars>` | `printUrl` true (default) |
| stdout | `dsh web: opening the default browser; pass --no-open to disable` | `openBrowser` true and not SSH, printed right after the URL line |
| stderr | `dsh web: listening on <host> over plain HTTP; restrict this port to a trusted proxy or network` | non-loopback bind with no TLS (`console.warn`) |
| stderr | `web-app: could not open the default browser because …` | browser handoff failure |

Sources: [web-app index.ts L197–L199][wa-warn] and [L225–L239][wa-print]. Docker and Kubernetes
usually merge stdout and stderr, so the warning line is commonly visible in the same stream as the
URL. The obsolete `(LAN: …)` suffix in older versions is a fourth shape (§4).

### Knobs that exist, and the one that does not

| Knob | Effect | Where |
|---|---|---|
| `printUrl` (default `true`) | Suppresses the URL line, with or without `publicUrl`; with no browser handoff the credential then never leaves the process | [web-app index.ts L75–L80][wa-config], [web-app README L83][wa-printurl] |
| `openBrowser` / `--no-open` | Suppresses the browser handoff; does **not** suppress the URL line | [startup.ts L65][startup], [web-app README L41][wa-start] |
| `publicUrl` / `--public-url` | Changes the advertised root (host and mount) only; grants no Host trust | [startup.ts L67][startup], [public-deployments L13, L25][pubdep] |
| `trustedHosts` / `--trusted-host` | Admits a non-loopback authority to the `/api` fence; irrelevant to the token itself | [connection index.ts L105][conn-config] |
| `cookieMaxAgeDays` (default 30) | Cookie lifetime only | [connection index.ts L106–L107, L115][conn-config] |
| **Token value / fixed token / env** | **Does not exist.** No `process.env` read in `web-app` or `client-connection`; no config field carries a token | [web-app index.ts][wa-src], [browser-auth.ts][ba-src] |

`DSH_WEB_URL` is *not* a token channel: it receives the clean advertised root
([web-app README L109][wa-clean]). A wrapper that wants a deterministic token would have to patch
`BrowserAuth` itself; that is unsupported and is not a fallback this ticket can rely on.

## 2. The exchange contract

`authorizeIndex` is the only browser-facing consumer of the token
([browser-auth.ts L263–L305][ba-exchange]):

1. **Request must be** `GET`, pathname **exactly `/`**, exactly **one** `token` query parameter, a
   present `Host` header, and a token equal to the process token under `timingSafeEqual`.
2. **Success:** `303` with `cache-control: no-store`, `location: ./`, `referrer-policy: no-referrer`,
   and one `Set-Cookie`:
   `dsh-auth-<base64url(sha256(authority))>=v1.<base64url(payload)>.<base64url(HMAC)>; Max-Age=2592000; Path=/; Expires=…; HttpOnly; SameSite=Strict` plus `Secure` iff the receiving listener
   serves TLS ([browser-auth.ts L132–L139][ba-cookie], [L263–L289][ba-exchange]).
3. **Token present but wrong, with a valid cookie:** `303` to clean `./` anyway — a stale token does
   not destroy a working session ([browser-auth.ts L290–L298][ba-exchange], [token note L17][note]).
4. **Everything else:** `401` with body
   `dsh web authentication required; reopen the URL printed by dsh web.` (no body for `HEAD`)
   ([browser-auth.ts L385–L392][ba-401]).

Observed against a live `0.2.1-rc.2` process:

| Request | Result |
|---|---|
| `GET /` (no cookie) | `401` + the message above |
| `GET /?token=<valid>` | `303`, `location: ./`, `Set-Cookie: dsh-auth-…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` |
| Same token again | `303` again — **the token is not single-use** |
| `GET /?token=<valid>&x=1` | `303` — extra query parameters are irrelevant |
| `GET /index.html?token=<valid>` | `401` — the token is honored only on path `/` |
| `HEAD /?token=<valid>` | `401` — method must be `GET` |
| `GET /` with the cookie | `200` |
| `GET /index.html` with the cookie | `200` (the document route is root **or** configured index) |
| `GET /connect?token=<valid>` | `302` to `./api/remote.mux` with a **v2** cookie — **not** a browser cookie; using it on `/` returns `401` |

### `/connect` is not the browser exchange

`/connect` is the API operator handshake (`302`, Mux destination, cookie payload version 2). The
index check accepts only version 1 (`isAuthenticated` → `payload?.version === 1`), so a proxy that
"logs in" through `/connect` will appear to succeed and then fail every page load with 401. It also
passes the Host fence first, so a non-loopback authority needs `--trusted-host`
([connection README L51][conn-connect], [connection index.ts L160–L164][conn-routes],
[browser-auth.ts L356–L357][ba-isauthed]). Use `GET /?token=`.

### Authority binding is exact and port-sensitive

`requestAudience` builds a URL from the **`Host` header alone** (HTTP: `url.host`; TLS listener:
`url.origin`, so the scheme is included) ([browser-auth.ts L78–L88][ba-audience]). Consequences,
confirmed live:

- A cookie minted with `Host: app.example:8443` works with that exact Host and fails (`401`) with
  `Host: app.example`.
- `X-Forwarded-Host` is ignored; it does not change the audience.
- An HTTP cookie cannot authenticate a listener that serves TLS, even on the same host and port
  ([connection README L45][conn-tls]).
- The `/api` fence is separate: an untrusted authority gets **403** even with a valid cookie; a
  trusted authority without a valid session gets **401** ([connection README L47][conn-fence]).
  The index route itself is not Host-fenced, so a wrong Host can load the page and then fail every
  API call — test an API request, not only `/`, after a change.

## 3. Cookie lifetime, persistence, and revocation

- The HMAC secret is a `grant` record at `client-connection/browser-session` in
  `$DSH_HOME/.credentials.yaml` (mode `600`) with the shipped local credentials provider; it is
  created on first activation and reloaded on the next activation
  ([connection README L43][conn-cookie], [token note L21][note]).
- **The token changes every start; an unexpired cookie remains valid across restarts on the same
  authority.** The design note explicitly rejected rotating the secret per restart
  ([token note L39][note-rotate]).
- Default lifetime is 30 days (`cookieMaxAgeDays`, absolute issue/expiry interval, not sliding)
  ([connection index.ts L106–L107][conn-config], [browser-auth.ts L380–L382][ba-verify]).
- Revocation is coarse: delete the credential record and restart; there is no logout
  ([connection README L83][conn-revoke], [token note L21][note]).
- Clock skew matters: `issuedAt > now` or `expiresAt <= now` rejects the cookie
  ([browser-auth.ts L380–L381][ba-verify]).
- In this repo, `DSH_HOME=/home/node/.dsh` is the `dsh-home` named volume
  (`Dockerfile:321`, `compose.yaml:22`), so the secret and therefore browser cookies survive
  container rebuilds and restarts. Wiping the volume or replacing `.credentials.yaml` invalidates
  every existing cookie — verified live.

This asymmetry is the single most useful lever for the proxy: **token capture is needed only to
bootstrap a session; a warm cookie cache can carry users across DSH restarts without any token.**

## 4. Version stability

Every published `@deepseek-ai/dsh` version is a pre-release; as of 2026-10-20 npm dist-tags are
`latest = next = 0.2.1-rc.2`, `alpha = 0.2.1-alpha.5`. The admin feature's "other official versions"
therefore means a moving set of alphas and RCs, not a stable line.

| Version range (published) | Printed `dsh web:` line | Browser auth | Relevant flags |
|---|---|---|---|
| `0.0.1-rc.1` – `0.1.1-rc.2` (2026-08-10 – 08-21) | `dsh web: http://127.0.0.1:<port>` plus ` (LAN: http://<ip>:<port>)` when a LAN address exists; **no token** | **None** — no `authorizeIndex`, no cookie, no 401 | `--host`, `--port`, `--no-open`, `--trusted-host` |
| `0.1.2-alpha.2` – `0.2.0-rc.2` (2026-08-30 – 09-29) | `dsh web: http://127.0.0.1:<port>/?token=…` plus optional ` (LAN: http://<ip>:<port>/?token=…)` | Token → v1 cookie; 303; 401 | same |
| `0.2.1-alpha.1` (2026-10-03) | Tokenized; root may be the `--public-url` value; LAN suffix still present | same | **adds `--public-url`** |
| `0.2.1-alpha.2` – `0.2.1-rc.2` (2026-10-09 – 10-17) | `dsh web: <advertised-root>?token=…` — **single URL, no LAN suffix** | same | **adds `--tls-cert`/`--tls-key`**; stderr warning for non-loopback HTTP |

What is stable inside the token era (`>= 0.1.2-alpha.2`):

- 32-byte random token, 43-char base64url, query name `token`.
- `GET /` + exactly one token → `303 ./` + authority-bound cookie; everything else 401.
- Cookie payload version 1 for the browser cookie; secret record version 1; `dsh-auth-` prefix;
  `Max-Age` from `cookieMaxAgeDays`, `Path=/`, `HttpOnly`, `SameSite=Strict`.
- `/connect` (added later, first present in `0.2.1-alpha.5`) remains API-only.

What is **not** stable:

- Whether a token exists at all (absent before `0.1.2-alpha.2`).
- The line suffix (`(LAN: …)` through `0.2.1-alpha.1`; gone from `0.2.1-alpha.2`).
- The advertised host is not stable: the default is a loopback constant through `0.2.1-alpha.1`,
  the bind-address origin from `0.2.1-alpha.2`, and `publicUrl` overrides it from `0.2.1-alpha.1`
  onward.
- Available flags. Passing `--public-url` to `0.2.0-rc.2`, or `--tls-cert` to
  `0.2.1-alpha.1`, is rejected by the app's commander program (unknown option) and the process
  exits instead of serving — gate new flags by version or `--help` probe (source-derived; the
  failure mode was not exercised against an old binary here)
  ([startup.ts L64–L70][startup], [0.2.0-rc.2 startup][npm-020]).
- The presence of a stderr `dsh web:` line with the same prefix (`0.2.1-alpha.2+`).

There is **no published stability guarantee** for the line text. The upstream README calls the line
a readiness signal and documents the flags, but treats it as operator-facing output, not a machine
contract ([web-app README L111–L113][wa-readiness]). Treat the format as a heuristic with fallbacks,
not as an ABI.

### Switching versions behind the proxy

- **Browser sessions survive a version switch** as long as `$DSH_HOME` and the listener authority
  stay the same: the browser cookie payload (v1) and the secret record (v1) have not changed across
  the token era. A version change rotates the token, not the cookie.
- The proxy must parse both line shapes (with and without the `(LAN: …)` suffix) if the admin feature
  can select anything in `0.1.2-alpha.2` – `0.2.1-alpha.1`.
- It must **not** pass `--public-url` or TLS flags to versions that lack them; that is a startup
  error, not an ignored option.
- It must handle the no-token era (`<= 0.1.1-rc.2`) explicitly: those versions have no
  `authorizeIndex` and their frontend-static serves the index without a browser session, so there is
  nothing to exchange and no 401 to heal ([0.1.1-rc.2 frontend-static][npm-011-fs]).

## 5. Capture options

| Option | Viability | Notes |
|---|---|---|
| **Child stdout line events** (proxy spawns DSH) | **Recommended** | Exact process association, no rotation race, works with Docker/K8s merged logs if the proxy is the parent. Must parse generically and redact the token in its own logs. |
| Log-file polling / `docker logs` | Workable fallback | Races with rotation, truncation, late attach, and multiple processes appending to one stream; line may predate the tail offset. The repo's smoke tests already do this (`scripts/smoke.sh:221–223`, `scripts/lan-smoke.sh:111–113`). |
| Fixed token via env/config | **Impossible** | No such env or config exists. Only a code patch to `BrowserAuth` would do it. |
| Deterministic cookie via `.credentials.yaml` | Unsupported | The secret is readable, but recreating the HMAC cookie format and audience is reverse-engineering an internal format that already has two payload versions (v1 browser, v2 API). Do not build on it. |
| `/connect?token=` | Wrong flow | Produces a v2 API cookie that does not open the index (verified: 401). |
| Cookie cache from a previous run | **Strong fallback** | Valid up to `cookieMaxAgeDays` on the same authority, across restarts. Bootstrap still needs one token exchange (or a human login). |
| Manual `?token=` passthrough | Must be preserved | Forward a request carrying `token` untouched (after prefix strip) and relay the 303/`Set-Cookie`; this is the human fallback when capture fails. |

Capture gotchas found:

- **Readiness is delayed.** The line prints after Loader settlement, not at listen time. Measured on
  this host: **9.8 s** from exec to line on a warm `DSH_HOME`; on the order of **50 s** in one
  fresh-profile run (timestamp comparison, not a controlled benchmark). The listener is mounted
  earlier and answers `401` once Connection is up. A proxy must wait well past listen readiness
  (suggest 120 s) before declaring failure.
- **stdout is the only channel.** The token line is `console.log`; stderr carries only warnings and
  browser-open diagnostics. Capturing stderr alone never finds the token.
- **Merged logs can contain up to three `dsh web:`-prefixed lines plus a `web-app:` diagnostic.**
  Require a parseable URL with a `token` parameter, not the prefix.
- **One line per process.** Restarts append a new line; a log-file reader must bind the *latest*
  line to the *current* process start, or it will reuse a dead token (exchange 401). With multiple
  replicas, one shared log stream makes that binding ambiguous.
- **`printUrl: false` makes automatic bootstrap impossible.** The token still exists in memory but
  is never emitted; `DSH_WEB_URL` is clean and cannot substitute. If the admin feature composes a
  config with `printUrl: false`, the proxy must fail loudly rather than wait forever.
- **Token leakage.** The line is a bearer credential until process exit. Proxy logs, crash dumps,
  and `docker inspect`-style capture must redact it.

## 6. Failure modes and what the proxy can do

| Symptom | Likely cause | Detection | Proxy action / fallback |
|---|---|---|---|
| No URL line within timeout | `printUrl: false`; required startup audit failed; frontend dist missing; crash; version ≤ `0.1.1-rc.2` (legacy, no token by design) | Child exit code, stderr, timeout; unauth `GET /` returns `200` on legacy vs `401` on token era | Legacy: pass through. Token era: keep cached cookie if valid; otherwise serve a manual-token page and an actionable error. Never loop forever. |
| Line found, exchange `401` | Token from a previous process (log race); token truncated by a regex; extra/missing `token` param; `Host` missing | Exchange response status/body | Re-read the *latest* line for the current process; retry once; then fall back to cookie/manual. Log the parsed URL with the token redacted. |
| Exchange works, page loads, `/api` returns `403` | Browser-facing authority not in `--trusted-host` (or proxy rewrote Host to an unaccepted value) | API probe with the cookie | Require `--trusted-host <authority>` when preserving Host; verify with an API call after exchange, not just `/`. |
| Exchange works, page loads, then all calls `401` | Cookie minted for a different authority: wrong port, `Host: app.example:443` vs browser's `Host: app.example`, HTTP cookie on a TLS listener, proxy rewrites Host inconsistently | Compare `Host` on browser request vs exchange request; inspect cookie name/audience | Always exchange with the browser's **verbatim** `Host` (default ports omitted), and keep that Host on all backend requests. Do not mix "preserve" and "rewrite". |
| Exchange works, browser doesn't keep the cookie | `Path=/` while serving under `/ui/`; the proxy drops or rewrites `Set-Cookie`; the browser rejects the domain/path; third-party-cookie policy | Browser devtools; `Set-Cookie` relay logs | Rewrite `Path` to the mount and add `Secure` on the HTTPS leg, as upstream's proxy contract requires ([public-deployments L20][pubdep]). Do not rewrite the name or value. |
| Page `401` for a returning user | Cookie expired (>30 days), secret rotated (volume wiped/replaced), `cookieMaxAgeDays` reduced, port/host/scheme changed, clock skew | 401 body text; cookie `Expires`; compare authority | If a current token is held, re-exchange and re-set the cookie, then replay the navigation once. Otherwise manual token page. |
| Token line valid, but restart breaks all users | Proxy persisted the token instead of the cookie, or pinned the token to the old process | Token age vs process start | Treat the token as per-process; persist only the cookie cache. |
| Stale cookie + stale token | Token line from an old log entry, cookie still valid | Exchange returns `401` while `/` with the cookie returns `200` | Prefer the cookie; do not clear it because a token failed. |
| Browser cookie valid but `/connect` used | `/connect` mints v2, index accepts v1 only | `/` 401 after a `302 /connect` | Use `GET /?token=` for the browser. |
| Multiple replicas disagree | Each process has its own token; cookie secrets differ unless they share `DSH_HOME` | Cross-instance requests 401 | Capture per instance; sticky routing by cookie; shared `DSH_HOME` only if concurrent writes are safe (upstream and this repo both target one instance — `README.md:148`). |
| Log rotation loses the line | Aggregated/rotated log file | Missing offset / truncated file | Prefer child stdout; otherwise re-read from the beginning once, then manual fallback. |
| Token appears in proxy logs | Raw line logged | Log review | Redact `token` values at capture time; never log the exchange URL. |

### What the proxy cannot do

- It cannot mint a browser session without either the process token or an already-valid cookie; the
  secret file alone is not a supported interface.
- It cannot make an HTTP-minted cookie valid for a TLS listener, or for a different port/hostname.
- It cannot use an `Authorization` header: DSH accepts no token there
  ([connection README L41][conn-readme]).
- It cannot rely on `/connect` for the page.
- It cannot make `printUrl: false` recoverable except by changing config and restarting.

## 7. Recommended proxy behavior

1. **Own the child process.** Spawn `dsh --profile web …`, capture stdout line-by-line, mirror it to
   the container log, and parse a candidate line with `new URL()`: require exactly one `token`
   parameter and an `http(s)` scheme. Do not hardcode `127.0.0.1`, a port, or end-of-line — accept
   an optional trailing `(LAN: …)` and a `publicUrl` host. The printed scheme is the *advertised*
   one, not necessarily the listener's; use it only to recognize the URL, and dial the backend as
   configured.
2. **Bind the token to the process instance**, not to the log file: keep `{pid, startedAt, token}`;
   invalidate on exit. Timeout around 120 s, with a health probe that treats `401` on `/` as "DSH is
   up but not yet authenticated".
3. **Exchange with the browser's request headers.** Use the exact `Host` the browser sent (omit
   default ports exactly as the browser does), `GET /?token=…`, and do not add forwarding headers as
   a substitute for Host. Translate the backend's relative `Location: ./` to the external mount and
   relay `Set-Cookie` with `Path` rewritten to the mount and `Secure` added on the HTTPS leg. Forward
   `Upgrade`/`Connection` and the `Cookie` header on WebSocket upgrades.
4. **Cache the cookie per authority** with its `Max-Age`/`Expires`, keyed by the external authority,
   and reuse it across DSH restarts. This makes the token path a bootstrap-only dependency. Refresh
   proactively near expiry when a token is held; otherwise keep serving the cached cookie until it
   actually expires.
5. **Self-heal a stale session** only when a current token is held: on a document request returning
   the 401 body, exchange once, set the cookie, and redirect back to the clean path. Guard against
   loops (one attempt per request/session, then show the manual page).
6. **Preserve a manual `?token=` path.** If a request already carries `token`, forward it (prefix
   stripped, Host preserved) and relay the response. Never strip or consume the token before DSH
   sees it. This keeps the upstream-documented operator workflow working when capture fails.
7. **Keep `printUrl` true.** Do not compose `printUrl: false` in the web profile. `--no-open` is fine
   and desirable in a container; it does not suppress the line.
8. **Choose one Host strategy and apply it everywhere.** Either preserve the browser Host and pass
   `--trusted-host <authority>` (upstream's documented model), or rewrite Host consistently to the
   loopback authority (no trusted-host needed, but `DSH_WEB_URL` and advertised URLs then point at
   loopback). Mixing them produces a page that loads and an API that 403s or 401s.
9. **Do not fabricate cookies** from `.credentials.yaml`, and do not depend on `/connect` for the
   browser.
10. **Redact the token** in proxy logs, error messages, and metrics.

Fallback ladder, in order: warm cookie cache → child stdout capture → log-file re-read →
manual `?token=` passthrough → legacy no-auth passthrough (`<= 0.1.1-rc.2`) → explicit operator error.

## 8. Compatibility detection

Cheap checks, in order of reliability:

1. **Version read:** `dsh --version` prints the installed package version (`0.2.1-rc.2` here). Use it
   only to gate flags and to warn; prerelease ordering makes range checks error-prone
   (`0.2.1-alpha.2 < 0.2.1-rc.1`), so compare against a known allowlist or the exact `DSH_VERSION`
   the image was built with (`Dockerfile:6`, `Dockerfile:24`).
2. **Auth feature probe:** unauthenticated `GET /` → `401` with the DSH message means token era;
   `200` with the DSH document means legacy (≤ `0.1.1-rc.2`). A `403` on `/api` with a valid cookie
   means the authority is not trusted (config problem, not a version problem).
3. **Flag probe:** `dsh --profile web --help` lists `--public-url` (`0.2.1-alpha.1+`) and
   `--tls-cert`/`--tls-key` (`0.2.1-alpha.2+`). Gate those flags; passing them to older versions is
   a startup failure, not a warning.
4. **Line-shape parse:** accept `^dsh web: <url>( \(LAN: <url>\))?$`, parse the first URL, require a
   `token` query parameter of 43 base64url characters. Reject the "opening the default browser"
   line (no URL) and the stderr warning (no URL).
5. **Do not infer** the version from the presence of a token alone: `0.1.2-alpha.2+` all have one,
   but the line suffix and flags differ.

## 9. Test suggestions

Unit / parser:

- Table-driven parser cases built from the real shapes in §4, including:
  `dsh web: http://127.0.0.1:3080/?token=<43>` (current),
  `dsh web: http://127.0.0.1:3080/?token=<43> (LAN: http://10.0.0.2:3080/?token=<43>)` (0.1.2–0.2.1-alpha.1),
  `dsh web: http://127.0.0.1:3080 (LAN: http://10.0.0.2:3080)` (≤ 0.1.1, no token),
  `dsh web: opening the default browser; pass --no-open to disable`,
  `dsh web: listening on 10.0.0.2 over plain HTTP; …` (stderr),
  `dsh web: https://app.example/ui/?token=<43>` (publicUrl with mount).
- Assert the parser never logs the raw token, and rejects duplicate/empty `token` parameters.

Contract tests against a fake upstream:

- `401` on bare `/`; `303` + `Set-Cookie` on exactly `GET /?token=`; `401` on `/index.html?token=`,
  `HEAD`, and two `token` parameters.
- Authority fidelity: exchange with `Host: app.example`; then serve a request carrying
  `Host: app.example:8443` and assert the proxy does not treat the cookie as valid (and that a
  correct-host request succeeds).
- `Set-Cookie` relay: backend `Path=/`, no `Secure`; assert the browser-facing cookie gets the mount
  path and `Secure` on an HTTPS leg.
- 401 refresh: one exchange attempt, one retry, no loop; then manual page.
- Upstream 403 on `/api` produces an actionable error, not a silent page.

Integration with a real DSH (no Docker needed):

```sh
# Reproduced for this note with a throwaway home:
DSH_HOME=/tmp/dsh-home dsh --profile web --port 0 --no-open > /tmp/out.log 2>/tmp/err.log &
# wait until the stdout line appears, then parse it:
URL=$(sed -n 's#^dsh web: \(http[^ ]*\)$#\1#p' /tmp/out.log)
TOKEN=$(printf '%s' "$URL" | sed -n 's#.*/?token=##p')
PORT=$(printf '%s' "$URL" | sed -n 's#http://127\.0\.0\.1:\([0-9]*\)/.*#\1#p')
curl -s -i "http://127.0.0.1:${PORT}/?token=${TOKEN}"                    # 303 + Set-Cookie
curl -s -b jar -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT}/"  # 200
```

- Restart with the same `DSH_HOME` and port: old token `401`, old cookie `200`, new token `303`.
- Delete `$DSH_HOME/.credentials.yaml`, restart: old cookie `401`; new token `303` and a new record.
- `printUrl: false` patch: no line; proxy must reach its documented timeout and manual fallback.
- Legacy: install `@deepseek-ai/dsh@0.1.1-rc.2` in a scratch prefix and assert no token line, `200`
  on `/`, and that the proxy disables exchange.

Multi-instance / operations:

- Two homes on two ports: per-instance token capture; cookies do not cross instances.
- Log rotation/truncation while running: proxy re-reads once, then manual fallback.
- Proxy restart with DSH still running: cookie cache continues to serve; no token needed.
- Docker/K8s merged stdout+stderr: parser ignores the stderr warning line.

## 10. Live evidence log

All checks below were run on 2026-10-20 against `/opt/dsh` `@deepseek-ai/dsh@0.2.1-rc.2`, with
`DSH_HOME=/tmp/dshprobe/home`, `--port 0` or a fixed `46627`, `--no-open`, HTTP listener.

| Check | Observed |
|---|---|
| stdout line | `dsh web: http://127.0.0.1:<port>/?token=<43 chars>` (43 chars; 32 bytes base64url) |
| stderr on loopback HTTP | empty |
| line timing | 9,803 ms on a warm home; on the order of 50 s on one fresh-profile run |
| bare `GET /` | `401`, `cache-control: no-store`, body `dsh web authentication required; reopen the URL printed by dsh web.` |
| `GET /?token=…` | `303`, `location: ./`, `set-cookie: dsh-auth-<43>=v1.<payload>.<sig>; Max-Age=2592000; Path=/; Expires=…; HttpOnly; SameSite=Strict` |
| token reuse | second exchange also `303` |
| token + extra query param | `303` |
| token on `/index.html` | `401` |
| `HEAD /?token=` | `401` |
| cookie on `/` and `/index.html` | `200` |
| same token after restart | `401` (token rotated) |
| same cookie after restart, same port | `200` |
| old token + valid cookie | `303` |
| cookie after deleting `.credentials.yaml` + restart | `401`; a new record is created |
| `/connect?token=` | `302 ./api/remote.mux` with `v2` cookie; that cookie on `/` → `401` |
| Host `app.example:8443` exchange, same Host | `303`, then `200` |
| same cookie with `Host: app.example` | `401` (port is part of the audience) |
| `X-Forwarded-Host` | ignored; cookie audience unchanged |
| `/api` with untrusted Host + valid cookie | `403` |
| `/api` with loopback Host and wrong-authority cookie | `401` |
| `.credentials.yaml` | mode `600`, `records: client-connection/browser-session`, `kind: grant`, `payload.version: 1` |

Commands used are the `curl`/`dsh` snippets in §9; no container was involved.

## Sources

Upstream source at tag `dsh-v0.2.1-rc.2` (also installed at
`/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`):

- [browser-auth.ts L14–L20][ba-consts] — token query name, cookie prefix, payload/secret versions.
- [browser-auth.ts L61–L67][ba-token] — per-process token generation.
- [browser-auth.ts L78–L88][ba-audience] — authority from `Host` (scheme only for TLS).
- [browser-auth.ts L132–L139][ba-cookie] — cookie attributes.
- [browser-auth.ts L244–L248][ba-url] — token appended to the advertised URL.
- [browser-auth.ts L263–L305][ba-exchange] — `GET /?token=` exchange, 303/401 branches.
- [browser-auth.ts L380–L382][ba-verify] — issued/expiry validation.
- [browser-auth.ts L385–L392][ba-401] — 401 body.
- [connection/src/index.ts L105–L117][conn-config] — `trustedHosts`, `cookieMaxAgeDays`.
- [connection/src/index.ts L136–L140][conn-create] — `BrowserAuth.create(ctx.root, …)`.
- [connection/src/index.ts L160–L164][conn-routes] — `/connect` route (API only).
- [web-app/src/index.ts L75–L80][wa-config] — `printUrl`, `publicUrl`.
- [web-app/src/index.ts L197–L199][wa-warn] — stderr warning with `dsh web:` prefix.
- [web-app/src/index.ts L218–L246][wa-print] — readiness, `console.log` line, handoff.
- [web-app/src/startup.ts L64–L70][startup] — `--public-url`, `--trusted-host`, TLS flags.
- [web-app/src/public-url.ts L20–L38][pub-url] — advertised-root validation, trailing slash.
- [dsh-web-app README L41, L83, L109–L113][wa-start] — tokenized line, `printUrl: false`, clean
  `DSH_WEB_URL`, readiness semantics.
- [dsh-client-connection README L41, L43, L45, L47, L51, L83][conn-readme] — auth, cookie
  persistence/authority, TLS audience, Host fence, `/connect`, no logout.
- [public-deployments.md L11–L27][pubdep] — proxy contract: preserve Host, strip prefix, forward
  upgrades, rewrite cookie scope, redirect bare mount, trusted authority.
- [web-server.md L84, L86][ws-doc] — listener behavior; the webserver itself never prints the URL.
- [browser token auth note L17–L21, L39][note] — lifecycle, persistence, rejected alternatives.

Version history evidence (npm tarballs; unpkg direct links):

- `0.0.1-rc.1`, `0.1.0-rc.2`, `0.1.1-rc.2`: [0.1.1 web-app lib/index.js:199][npm-011] prints
  `dsh web: ${webUrl}` with no token (0.1.0 at `:107`, 0.0.1 at `:121`; tarballs
  [0.0.1][npm-001], [0.1.0][npm-010]); [client-connection][npm-011-conn] has no
  `authorizeIndex`/`launchToken`.
- `0.1.2-alpha.2`: [web-app lib/index.js:211][npm-012] prints the tokenized URL plus `(LAN: …)`;
  [client-connection lib/index.js:199–201][npm-012-conn] introduces `TOKEN_QUERY`, cookie v1, 303.
- `0.2.0-rc.2`: [startup.js][npm-020] has no `--public-url` or TLS flags; LAN suffix still printed.
- `0.2.1-alpha.1`: [startup.js][npm-0211] adds `--public-url`; LAN suffix still printed.
- `0.2.1-alpha.2`: [web-app lib/index.js:188,214][npm-0212] adds the stderr warning and drops the LAN
  suffix; startup adds `--tls-cert`/`--tls-key`.
- `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`: same shape as alpha.2; `/connect` present (API only).

Repo context:

- `Dockerfile:6` (`ARG DSH_VERSION=0.2.1-rc.2`), `Dockerfile:321` (`DSH_HOME=/home/node/.dsh`),
  `compose.yaml:22` (`dsh-home` volume), `README.md:148` (single replica by design),
  `scripts/smoke.sh:221–223` and `scripts/lan-smoke.sh:111–113` (current log-scraping regex).

[ba-src]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts
[ba-consts]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L14-L20
[ba-token]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L61-L67
[ba-audience]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L78-L88
[ba-cookie]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L132-L139
[ba-url]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L244-L248
[ba-exchange]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L263-L305
[ba-verify]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L380-L382
[ba-401]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L385-L392
[ba-isauthed]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/browser-auth.ts#L356-L357
[conn-config]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/index.ts#L105-L117
[conn-create]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/index.ts#L136-L140
[conn-routes]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/index.ts#L160-L164
[conn-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md#L41
[conn-cookie]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md#L43
[conn-tls]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md#L45
[conn-fence]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md#L47
[conn-connect]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md#L51
[conn-revoke]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md#L83
[wa-src]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/index.ts
[wa-config]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/index.ts#L75-L80
[wa-warn]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/index.ts#L197-L199
[wa-print]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/index.ts#L218-L246
[wa-root]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/index.ts#L200-L202
[wa-start]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/README.md#L41
[wa-printurl]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/README.md#L83
[wa-clean]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/README.md#L109
[wa-readiness]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/README.md#L111-L113
[startup]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/startup.ts#L64-L70
[pub-url]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/public-url.ts#L20-L38
[pubdep]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/guide/public-deployments.md#L11-L27
[ws-doc]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/web-server.md#L84-L86
[note]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md#L17-L21
[note-rotate]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md#L39
[npm-001]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.0.1-rc.1/lib/index.js
[npm-010]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.1.0-rc.2/lib/index.js
[npm-011]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.1.1-rc.2/lib/index.js
[npm-011-fs]: https://unpkg.com/@deepseek-ai/dsh-host-frontend-static@0.1.1-rc.2/lib/index.js
[npm-011-conn]: https://unpkg.com/@deepseek-ai/dsh-client-connection@0.1.1-rc.2/lib/index.js
[npm-012]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.1.2-alpha.2/lib/index.js
[npm-012-conn]: https://unpkg.com/@deepseek-ai/dsh-client-connection@0.1.2-alpha.2/lib/index.js
[npm-020]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.2.0-rc.2/lib/startup.js
[npm-0211]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.2.1-alpha.1/lib/startup.js
[npm-0212]: https://unpkg.com/@deepseek-ai/dsh-web-app@0.2.1-alpha.2/lib/index.js
