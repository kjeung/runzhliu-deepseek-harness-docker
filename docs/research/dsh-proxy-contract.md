# DSH Web proxy transparency contract (0.2.1-rc.2)

Research for wayfinder ticket #4: replace the raw TCP relay (`scripts/dsh-web-relay.cjs`)
with a Node HTTP/WS reverse proxy, with one special case — when `GET /` answers `401`,
retry server-side with the DSH launch token, relay `Set-Cookie`, stay transparent
otherwise.

- **Pinned version:** DSH `0.2.1-rc.2` (`@deepseek-ai/dsh`, all bundled packages at the same version).
- **Date:** 2026-10-20.
- **Method:** Docker is not available in this environment, so nothing here was observed
  through a running image. Claims are marked:
  - **[src]** read from the installed package source;
  - **[doc]** stated by the package README;
  - **[exp]** verified with a micro-experiment on the image's runtime, Node `v24.22.0`;
  - **[repo]** this repository.
- **Non-goal:** this document is not a design doc for the final code. It fixes the contract
  and the acceptance tests so the implementation has a target it cannot quietly miss.

> **Errata (2026-10-24, #13):** the raw TCP relay named in this note
> (`scripts/dsh-web-relay.cjs` and its test) retired when the DSH supervisor
> took ownership of `dsh`. The concrete-address forwarder and the in-memory
> launch token now live in `scripts/dsh-web-supervisor.cjs`, and the proxy
> designed here consumes that supervisor boundary. Everything below is the
> 2026-10-20 capture and is kept as evidence, not as current state.

> **Errata (2026-10-24, #15):** the proxy is implemented in
> `scripts/dsh-web-proxy.cjs` and loaded by the supervisor in the same
> process; the forwarder named above is retired. This spec fixes the v1
> browser-cookie cache and fallback-injection model, the per-client exchange
> budget, the failure-surface routing, and `DSH_TRUSTED_HOSTS` as the single
> Host-gate source. Where this note differs (notably §8/§11.C retry breadth and
> the failure UX), spec #15 and the current code win; the 2026-10-20 evidence
> below is unchanged.

---

## 0. Verdict

1. The proxy **cannot be byte-transparent**; it must be **semantically transparent**.
   A `node:http` server parses and re-serializes messages, so header order, header
   casing, duplicate non-`Set-Cookie` headers, and hop-by-hop framing necessarily change.
   §5 is the exhaustive list of what may change. Everything else is a bug.
2. Two invariants dominate the rest: **`Host` is forwarded verbatim** and
   **`Cookie`/`Set-Cookie` are forwarded untouched**. DSH binds the browser cookie to the
   request authority, so rewriting `Host` on *any* hop — including the token retry —
   produces a silent, permanent `401` loop (§3.2).
3. Exactly one special case is defensible: **`GET` + exact path `/` + no `token` query +
   response `401` + token known**. `HEAD /`, `/index.html`, `/?token=…`, `POST /`, and
   every non-`/` path must pass through untouched (§6).
4. The retry is **an authentication-model change, not a transport change**: it removes the
   launch token as a barrier for anything that can reach the proxy listener. That
   contradicts this repo's current security documentation and two of its smoke tests
   (§8). Decide it explicitly before implementing.
5. **Prefer `node:http` + `node:net`** over `http-proxy`. Both `http-proxy@1.18.1` and
   `http-proxy-3@2.0.1` rewrite `Connection` to `close` on the upstream request by default,
   and `http-proxy-3` additionally strips `Trailer`; each violates this contract out of the
   box (§9).
6. The proxy needs a **launch-token source that does not exist yet**. DSH only prints the
   token on its `dsh web:` stdout line; it is not in the environment, the page, or on disk
   (§7). This is a supervision change, not a proxy detail.

---

## 1. Topology

| Hop | Address | `Host` seen by DSH | Today | With the proxy |
| --- | --- | --- | --- | --- |
| Host browser → published port | `127.0.0.1:3080` (Compose default) | `127.0.0.1:3080` | Docker NAT → container IP → TCP relay → `127.0.0.1:3080` | Docker NAT → container IP → **proxy** → `127.0.0.1:3080` |
| LAN browser → Caddy | `https://${DSH_LAN_HOST}:8443` | `${DSH_LAN_HOST}:8443` | Caddy → container IP → relay → DSH | Caddy → container IP → **proxy** → DSH |
| In-container probe | `127.0.0.1:3080` | `127.0.0.1:3080` | DSH directly | DSH directly (unchanged) |
| Docker network peer | `172.x.x.x:3080` | `172.x.x.x:3080` | relay → DSH | proxy → DSH (still `403` on `/api`, see §3.3) |

DSH rejects wildcard binds and stays on `127.0.0.1:3080` **[repo]** `web.cordis.patch.yml:25-29`;
the relay exists only because the container IP must accept published traffic
**[repo]** `README.en.md:111`, `scripts/deepseek-harness-entrypoint:192`.
Caddy is the existing, working reference proxy: it **preserves `Host`**, disables response
buffering with `flush_interval -1`, and does not touch the cookie except to append `Secure`
**[repo]** `config/Caddyfile.lan`.

The proxy must behave like that Caddy hop, not like a gateway that rewrites.

---

## 2. Route inventory (shipped Web composition)

`dsh-host-webserver` is a plain route table: exact match, then longest prefix, then one
fallback; upgrades are exact-match only and unmatched upgrades destroy the socket
**[doc]** `@deepseek-ai/dsh-host-webserver/README.md` ("Registering routes").
Every route below is registered by a plugin, not by the webserver itself.

| Path | Match | Methods | Gate | Response shape | Long-lived / streaming | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | fallback (index) | GET, HEAD | `authorizeIndex`: token → `303`+cookie, cookie → `200`, else `401` | HTML (`text/html; charset=utf-8`), re-rendered per request | no | `dsh-host-frontend-static/lib/index.js:49-76`, `:87-96` |
| `/<asset>` (anything in dist) | fallback | GET, HEAD | **public** | static file; unknown ext → `application/octet-stream`; traversal → `403`; miss → `404`; non-GET/HEAD → `405` | no (may be gzip) | same, `:49-83` |
| `/api` | prefix | any (bridge dispatches; unclaimed → `404`) | Host/Origin fence + browser cookie or API cookie (`admit`) | JSON envelope, or `multipart/form-data` when a result carries byte attachments; `401`/`403`/`404`/`413`/`415`/`400` | no (chunked response possible) | `dsh-client-connection/lib/index.js:1046-1058`, `:40-110`, `:742-757` |
| `/api/session/uploadFileBinary` | Fetch route under `/api` | POST | same as `/api` | JSON; request body is **raw streaming** (`requestBody: "streaming"`), bypasses the 300 MiB aggregate cap | upload, up to 300 MiB for buffered routes; unbounded for this one | `dsh-client-file-upload/lib/index.js:72`, `:168-175`; `dsh-client-connection/lib/index.js:30`, `:95-101` |
| `/api/session.export` | Fetch route under `/api` | GET, HEAD | same as `/api` | `application/zip` + `Content-Disposition: attachment`, body is a streamed ZIP (no `Content-Length`) | **download, streaming** | `dsh-session-log-export/lib/index.js:488`, `:516-524`, `:558-563` |
| `/api/remote.mux` | **upgrade** (exact) | GET + `Upgrade: websocket` | `admitConnection`: `401`/`403`/`409` written as a plain HTTP response on the socket, then close | WebSocket; `ws` frames; `maxPayload` default 100 MiB; no permessage-deflate | **yes, long-lived, bidirectional, binary** | `dsh-api-gateway/lib/index.js:133`, `:300`, `:680-691`, `:780-822` |
| `/connect` | exact | GET | Host/Origin fence + launch token + `interactions` = `answer` or `none` | `302` → `./api/remote.mux` + API cookie; `400`/`401` | no | `dsh-client-connection/lib/index.js:504-545`, `:1059-1065` |
| `/plugins/<id>/client.js` (+ source maps, combo bundles) | prefix | GET, HEAD | **public** | JS/map bytes; `cache-control: public, max-age=31536000, immutable`; unknown → `404`, wrong method → `405` | no | `dsh-client-modules/lib/index.js:202`, `:564-568`, `:985-986` |
| `/plugins/events` | exact | GET, HEAD | **public** | `text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`; `: connected` then `data:` frames | **yes, SSE, unbounded** | `dsh-client-hmr/lib/index.js:5`, `:124-152` |
| `/browser-desktop/state` | exact | GET, HEAD | **public** | JSON `{revision,url,openedAt,desktop,pollIntervalMs}`, `cache-control: no-store` | no | `plugins/dsh-browser-desktop/index.js:157-175` |
| `/browser-desktop/open` | exact | POST | **public**, but same-origin check: `new URL(origin).host === req.headers.host` | JSON; `403` cross-origin, `400` bad body, `405` wrong method | no | `plugins/dsh-browser-desktop/index.js:62-70`, `:177-205` |
| `/open-in-app/apps` | exact | GET | `connection.requestRejection` (`401`/`403`) | JSON list | no | `dsh-host-open-in-app/lib/index.js:1126`, `:1271-1280` |
| `/open-in-app/icon/<id>` | prefix | GET | same | image bytes, `cache-control: public, max-age=3600`; `404` JSON | no | `:1129`, `:1281-1318` |
| `/open-in-app/open` | exact | POST | same | JSON; `415`/`400` | no | `:1132`, `:1320` |
| `/oauth/callback` | exact | GET | state + code check, only registered while a sign-in is pending | `400`/`410`/redirect | no | `dsh-deepseek-account-platform/lib/index.js:992-1010` |
| `/dsh-market/*` | — | — | market image only | — | — | `web.market.cordis.patch.yml` |

What does **not** exist in 0.2.1-rc.2, and therefore must not be invented by tests:

- no health, readiness, metrics, or version endpoint;
- no SSE endpoint other than `/plugins/events` (the session event stream is the logical
  `$events` stream **inside** `/api/remote.mux` **[doc]** `dsh-client-connection/README.md`
  ("Connection generation"));
- exactly **one** HTTP upgrade route in the Web composition (`/api/remote.mux`);
  `dsh-experimental-inspector` registers a second one, but only the separate
  `experimental-inspector` profile mounts it;
- no Range support anywhere: `frontend-static` reads whole files and answers `200`; the
  compression filter merely *excludes* `Content-Range` responses
  `dsh-host-webserver/lib/index.js:201`.

---

## 3. The authentication exchange, precisely

### 3.1 Outcomes on the index path

`authorizeIndex` **[src]** `dsh-client-connection/lib/index.js:458-505`:

| Request | Condition | Response |
| --- | --- | --- |
| `GET /?token=<correct>` | exactly one token param, matches this process's launch token, `authority` parseable (cookie irrelevant) | `303`, `location: ./`, `cache-control: no-store`, `referrer-policy: no-referrer`, `set-cookie: dsh-auth-<sha256(authority)>=…; Max-Age=…; Path=/; Expires=…; HttpOnly; SameSite=Strict` |
| `GET /?token=<wrong>` | token does not match, but a valid cookie is attached | `303`, `location: ./` (no new cookie) |
| `GET /?token=<wrong>` | token does not match and no valid cookie | `401` |
| `GET /` or `HEAD /` | valid cookie for this authority | handler runs (`200` index) |
| anything else on the index path | no/invalid cookie | `401` |

The `401` is **[src]** `:571-577` and was captured byte-for-byte on Node 24.22.0 **[exp]**:

```
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: text/plain; charset=utf-8
Transfer-Encoding: chunked

<68 bytes> "dsh web authentication required; reopen the URL printed by dsh web.\n"
```

`HEAD` gets the same status and headers with an empty body. Note the framing: **the 401 is
chunked**, not length-delimited. A proxy that buffers it for replay must record the bytes,
not assume `Content-Length`.

### 3.2 The cookie is bound to `Host`, and so is its *name*

- `requestAudience(headers)` = `new URL('http://' + Host).host` for a plain-HTTP listener
  **[src]** `:307-317`.
- Cookie name = `"dsh-auth-" + base64url(sha256(authority))` **[src]** `:335-337`.
- The signed payload repeats `authority`, and `authenticate` rejects a payload whose
  authority differs **[src]** `:380-405`, `:546-569`.
- The cookie is `Path=/`, `HttpOnly`, `SameSite=Strict`, `Secure` only when the listener
  itself serves TLS **[src]** `:347-351`, `:458-462`.

Consequence, and the single most expensive mistake available to this change:

> If the retry is issued with a synthesized `Host: 127.0.0.1:3080` instead of the client's
> `Host`, DSH mints `dsh-auth-<sha256("127.0.0.1:3080")>`. The browser stores it (name does
> not matter to the browser) and sends it back with `Host: 127.0.0.1:3080`… but the browser
> is talking to `172.18.0.2:3080` or `dsh.example:8443`, so DSH looks for
> `dsh-auth-<sha256("dsh.example:8443")>`, finds nothing, and answers `401`. The proxy
> retries, mints another cookie for the wrong authority, and the loop is permanent.

`SameSite=Strict` has a second, benign consequence worth a test: a navigation from an
external site does not carry the cookie, so the first visit always takes the
`401 → token → 303` path even for an already-authenticated browser.

### 3.3 `/api` and the WS upgrade enforce a *trust* fence before auth

`isTrustedApiRequest` **[src]** `:240-252` requires the `Host` to be loopback, the
listener's own bind IP, or a declared `trustedHosts` entry; rejects
`sec-fetch-site: cross-site`; and requires `Origin` (when present) to equal `Host`.
Failures are `403`; trusted-but-unauthenticated is `401` **[src]** `:742-757`.
The bind IP here is `127.0.0.1`, and the default Compose command passes no
`--trusted-host` **[repo]** `Dockerfile:374`, so **`172.18.0.2:3080` is not a trusted authority**: `/` may render, but
`/api` answers `403`. That is true today through the relay as well **[repo]**
`compose.lan.yaml` passes `--trusted-host ${DSH_LAN_HOST}` precisely for the LAN case.
The proxy must forward this `403` unchanged, not "fix" it.

The WS upgrade reuses the same fence; a rejected upgrade is **not** a WebSocket close
frame — it is a plain HTTP response written on the socket and then closed **[src]**
`dsh-api-gateway/lib/index.js:680-691`:

```
HTTP/1.1 401 Unauthorized
Connection: close
Content-Type: text/plain; charset=utf-8
Content-Length: 12

unauthorized
```

A proxy that only speaks the WebSocket framing for upgrades will hang or drop this; the
raw-pipe approach carries it for free.

---

## 4. Header and cookie contract

| Header | Who depends on it | Requirement | If violated |
| --- | --- | --- | --- |
| `Host` | cookie authority + name, `/api` trust fence, plugin same-origin check, Caddy trusted-host | **verbatim, every request, including the retry** | `401` loop (§3.2) or `403` |
| `Origin` | `/api` same-authority check; `/browser-desktop/open` | verbatim | `403` on all API calls / plugin open |
| `Sec-Fetch-Site` | `/api` fence rejects `cross-site` | verbatim | `403` (or a security hole if stripped) |
| `Cookie` | `dsh-auth-<authority>` lookup, API cookies | verbatim; never renamed, merged, or re-scoped | `401` |
| `Set-Cookie` | session minting | every value, byte-identical, one header line each; never joined | browser drops or mis-scopes session |
| `Upgrade` + `Connection` (request) | `/api/remote.mux` | exact `Upgrade: websocket`; connection token `Upgrade` | WS never establishes |
| `Sec-WebSocket-Key/Version/Protocol/Extensions` | `ws` handshake | verbatim both ways; the `101` headers (esp. `Sec-WebSocket-Accept`) must be the upstream's, not synthesized | handshake failure |
| `Accept-Encoding` | DSH's gzip middleware negotiates `gzip`/`identity` only | verbatim; **never inject or normalize** | client receives gzip it cannot decode, or loses compression |
| `Content-Encoding`, `Vary` | gzip responses | verbatim; proxy never decompresses or recompresses | double-encode / broken cache |
| `Content-Length` / `Transfer-Encoding` | framing | exactly one on the wire; body length unchanged; re-framing allowed (hop-by-hop) | truncated or hanging responses |
| `Range` / `If-Range` | nothing in DSH | pass through; do not implement ranges, do not add `Accept-Ranges` | surprising `206`/wrong bytes |
| `Trailer` / `TE` | nothing in DSH sends trailers today | pass through; do not strip. If a trailer ever appears, `node:http` exposes it only as `proxyRes.trailers` and requires `res.addTrailers()` — neither `http-proxy` nor `http-proxy-3` does this | contract drift; silent trailer loss |
| `Expect: 100-continue` | Node's server auto-answers `100` | must not hang; relay the body | upload stall |
| `Connection`, `Keep-Alive` (response) | client keep-alive | may be re-derived per hop | premature close or connection leak |
| `Authorization` | untouched by DSH | must not be added; Caddy strips it **[repo]** `config/Caddyfile.lan` | credential leak into DSH |
| `X-Forwarded-*` | **ignored by DSH by design** **[doc]** `dsh-client-connection/README.md` | don't add; they buy nothing and change bytes | none, but pointless drift |
| `Location` | `303 → ./`, `302 → ./api/remote.mux` | verbatim; both are relative | broken redirect |
| `Cache-Control`, `ETag`, `Last-Modified` | asset caching, `no-store` on auth | verbatim | stale auth page / uncached bundles |

`Date`: Node adds one automatically when the upstream header is not forwarded. Forwarding
`proxyRes.rawHeaders` preserves the upstream `Date` and suppresses the local one; that is
the closer-to-transparent choice.

---

## 5. Permitted deviations (the complete list)

`node:http` on both sides makes the following unavoidable. Everything here is allowed;
anything not here is a contract violation.

1. **Framing.** `Transfer-Encoding`/`Content-Length` may be re-derived per hop. The decoded
   body must be byte-identical.
2. **Header order and casing.** Node lowercases field names when reading `req.headers` and
   preserves them in `req.rawHeaders`; the proxy may forward either. (Forwarding
   `rawHeaders` preserves both, plus duplicates — see §9.3.)
3. **Duplicate non-`Set-Cookie` headers may be collapsed** by Node's parser (into `", "`
   or `"; "` for `Cookie`). `Set-Cookie` is special-cased by Node and stays an array.
4. **Hop-by-hop headers** (`Connection`, `Keep-Alive`, `Proxy-Connection`, and for 101 the
   upgrade set) are per-hop and may be re-derived.
5. **Node may add** `Date`, `Connection: keep-alive`, `Keep-Alive: timeout=…` when the
   upstream did not provide them. Prefer forwarding the upstream values when present.
6. **`100 Continue`** may be generated by the proxy's own server rather than relayed from
   DSH. Semantically identical.
7. **TCP-level details** (source port, connection reuse, socket count) are not part of the
   contract; only observable HTTP behavior is.

Nothing else may differ: no added `Via`/`Server`/`X-Forwarded-*`, no rewritten `Location`,
no cookie rewriting (not even `Secure`), no compression, no charset changes, no HTML or
URL rewriting (DSH's index is deliberately relative with `<base href="./">`
**[doc]** `dsh-host-frontend-static/README.md`; rewriting it breaks prefix mounts).

---

## 6. The special case: decision table

Interception is allowed **only** when all of the following hold:

- request method is exactly `GET`;
- `req.url` parses to pathname exactly `/`;
- the query contains **no** `token` parameter (zero or more other params);
- the proxy has a token for the current DSH process;
- the upstream response status is `401`;
- the `401` has no `Set-Cookie`;
- no response bytes have been written to the client yet.

Then: fully consume the `401`, issue exactly one retry with the same method, path
(+ existing query + `token=<token>`), same `Host`, same `Origin`/`Cookie`/other headers,
and relay whatever comes back. If the retry also returns `401`, relay it and stop
(no second retry, no loop).

| Request | `401` | Action |
| --- | --- | --- |
| `GET /` | yes | retry with `?token=` |
| `GET /?token=abc` | yes | **pass through** (would loop) |
| `GET /?foo=1` | yes | retry with `?foo=1&token=…` (DSH's `303` still lands on `./`) |
| `GET /index.html` | yes | pass through — DSH mints only on pathname `/` **[src]** `:462-472` |
| `HEAD /` | yes | pass through — the mint branch requires `GET` |
| `POST /`, `PUT /`, … | any | pass through |
| `GET /` | `303` | pass through verbatim (client without a cookie jar gets a redirect) |
| `GET /` | `200` | pass through |
| `GET /` | `403`, `404`, `5xx` | pass through |
| `GET /` | `401`, no token known | pass through |
| `/api/remote.mux` upgrade | `401` | pass through (retry cannot help; not `GET /`) |
| anything else | any | pass through |

Deliberate conservatism: a request that already carries a `token` parameter is never
retried, even if the token is stale. The alternative — replace an invalid token once —
would rescue bookmarked URLs after a restart, but it adds a second rewrite rule and a
second loop risk. Note that a stale-token bookmark normally still works after a restart,
because the persistent cookie takes the second `authorizeIndex` branch (`303`); only a
client that also lost its cookie sees `401`.

Implementation constraints that fall out of the table:

- The retry must reuse the **original** `Host` and must not add `X-Forwarded-Host`.
- The token is a query parameter only; DSH accepts **no** `Authorization`-header token
  **[doc]** `dsh-client-connection/README.md` ("Browser authentication and request trust").
- The `401` body must be buffered (68 bytes today) so it can be replayed if the retry
  fails. Do not stream the `401` and then try to retry.
- The token must never appear in a log line, an error page, or a `Location`.
- Concurrent `GET /` requests may each retry; DSH mints an equivalent cookie for each.

---

## 7. Where the token comes from (a hard dependency)

Facts:

- The launch token is `base64url(randomBytes(32))`, generated per process and held in a
  `WeakMap` keyed by the root context **[src]** `dsh-client-connection/lib/index.js:276-300`.
- The only disclosure path is the URL printed by `web-app`:
  `console.log('dsh web: ' + authenticatedUrl)` where `authenticatedUrl` appends
  `?token=…` **[src]** `dsh-web-app/lib/index.js:156-166`, enabled by `printUrl: true`
  **[src]** `dsh-web-app/cordis.patch.yml:197-203`.
- It is not in `process.env`, not in `window.__DSH_BOOT__` (that carries the recovery
  config and the module graph), not on disk, and not reachable over HTTP without the token
  itself. `DSH_WEB_URL` is the clean advertised URL and deliberately carries no token
  **[src]** `dsh-web-app/lib/index.js:38-39`, `:145-150`.
- The cookie **signing secret** is different and *is* persistent: a credential record in
  `$DSH_HOME/.credentials.yaml` **[src]** `:273`, `:391-406`. So a browser cookie survives a
  DSH/container restart; the launch token does not.
- `dshmarket` is configured with `allowRestart: false` **[repo]**
  `web.market.cordis.patch.yml`, so in-place DSH restarts do not happen in this image;
  a restart means a new container and a new token.

Options for the token source:

| Option | Shape | Cost / risk |
| --- | --- | --- |
| A. Proxy owns DSH's stdout | entrypoint starts DSH with `stdout: pipe` into the proxy; proxy tees lines to its own stdout and parses `^dsh web: ` | changes who supervises DSH; must preserve `docker logs` output (operators and `scripts/smoke.sh:221` grep it) |
| B. Entrypoint tees to a token file | entrypoint pipes DSH output through `tee` and a `sed` extractor into `/run/dsh/token` (mode 0600); proxy reads it on each `401` or on mtime change | pipeline changes `$!`/signal handling in `/bin/sh`; token on disk is a new (small) exposure |
| C. No auto-auth; users open the tokenized URL | zero new plumbing | does not satisfy the ticket's special case |
| D. Patch/config seam in DSH | not available in 0.2.1-rc.2 | out of scope |

Whichever is chosen: **the token must be treated as a bearer credential for remote code
execution** (DSH tools execute commands). It already appears in container logs, which is
how this repo tells users to find it **[repo]** `README.en.md:175` — so option A does not
create a new class of leak, while option B adds a file that must be `0600` and outside the
image layer. If the token is unknown or stale, the proxy must degrade to pure passthrough
(`401` to the client), never to "no auth".

---

## 8. Security consequence of the retry (decide before building)

The retry converts the launch token from "proof you saw the startup URL" into "something
the proxy knows". Through the proxy listener, `GET /` then always succeeds for any client
that can reach it, and the resulting cookie authenticates `/api` and `/api/remote.mux`.
The token stops being an access-control boundary on that listener; the remaining boundaries
are network reachability and, in LAN mode, Caddy's Basic Auth.

This is a direct contradiction with the current documented model:

- **[repo]** `SECURITY.md:9-11` — launch token, signed cookie, Host/Origin checks are the
  security story; loopback or `kubectl port-forward` are the supported boundaries.
- **[repo]** `README.en.md:103`, `:111-113`, `:162` — "preserves DSH's own launch-token,
  signed-cookie, and Host/Origin checks"; "noVNC is unauthenticated".
- **[repo]** `README.en.md:482` and `scripts/smoke.sh:219-224` — an unauthenticated root
  **must** return `401` through the published port. After the change it returns `303`, then
  `200` with a `Set-Cookie`; the smoke test fails by design.
- **[repo]** `scripts/lan-smoke.sh:106` — same assertion through Caddy; also fails.
  (`scripts/smoke.sh`'s `docker exec … 127.0.0.1:3080` checks, and `compose.yaml`'s
  healthcheck, keep hitting DSH directly and stay `401`.)

Options: ship the retry behind an explicit opt-in env flag (default off, documented as
"the token is disabled for everything that can reach this port"), or restrict it to
requests whose `Host` is a loopback authority (matches the default Compose publication, and
leaves LAN/Caddy behavior unchanged), or accept the model change and rewrite the docs and
smoke tests. Silent enablement is the one option that should not be taken.

---

## 9. Implementation route: Node built-ins vs `http-proxy`

### 9.1 Comparison

| | `node:http` + `node:net` | `http-proxy@1.18.1` | `http-proxy-3@2.0.1` | `httpxy@0.5.5` |
| --- | --- | --- | --- | --- |
| Runtime deps | 0 | `eventemitter3`, `requires-port`, `follow-redirects` | `debug`, `follow-redirects` | few |
| Latest release | n/a (runtime `Node 24.22.0`, image base `node:24-trixie`) | **1.18.1, 2020-05-17**; no release since | 2.0.1, 2026-08-27 (36 versions since 2025-05) | 0.5.5, 2026-07-09 |
| Node engines | — | `>=8` | `>=22` (matches image) | — |
| WS support | raw `upgrade` pipe (~30 lines) | own pass; re-serializes the `101` line and headers | same approach, socket-leak fixes claimed | yes |
| `Host` preserved by default | yes (you forward it) | yes, but `changeOrigin` silently rewrites | yes, same trap | yes |
| `Connection` forwarding | you choose | **forces `connection: close` upstream when no agent** | **same** | — |
| Request `Trailer` | passes through | passes through | **stripped** (DoS fix) | — |
| Client abort during a streaming response | you wire it | `req.on('aborted')` only (legacy event; not fired for aborts after the request completes); `proxyRes.pipe(res)` with no `res → proxyReq.destroy()` | `res.on('close')` → `proxyReq.destroy()` (better) | — |
| Header fidelity | best (`rawHeaders` arrays) | loses case/order; adds `Connection` on the response | same | — |
| Fits the `401` interception | yes (you own the response) | awkward (`selfHandleResponse` + manual replay) | awkward | awkward |
| Supply chain | none | 3 transitive packages, 6 years stale | 2 transitive, maintained | maintained |

Evidence for the two hard rows:

- `http-proxy` copies the request headers and then, with no agent,
  `outgoing.headers.connection = 'close'` — `http-proxy@1.18.1/lib/http-proxy/common.js:43,73`;
  `http-proxy-3@2.0.1/dist/lib/http-proxy/common.js:113-114` is the same logic.
- `http-proxy-3` deletes any request header whose lowercased name is `trailer`
  (`HEADER_BLACKLIST`), `http-proxy-3@2.0.1/dist/lib/http-proxy/common.js:22,82-88`.
- `http-proxy` writes the response headers with `res.setHeader` per key
  (`.../passes/web-outgoing.js:85-118`), and pipes the response body with no abort hook of
  its own (`.../passes/web-incoming.js:150-190`).
- `http-proxy-3` README: "THIS IS MAINTAINED AND READY TO USE IN PRODUCTION"; it names
  `http-proxy` as unmaintained (<https://github.com/sagemathinc/http-proxy-3>).
- `http-proxy`'s own npm metadata: `1.18.1` published 2020-05-17
  (<https://registry.npmjs.org/http-proxy>); `http-proxy-3` `2.0.1`, `engines.node >=22`
  (<https://registry.npmjs.org/http-proxy-3>).

### 9.2 Recommendation

**Use `node:http` for requests and a raw `net` pipe for upgrades.** Reasons, in order:

1. The single special case needs to *intercept a response, discard it, and replay the
   request*; that is easy when you own the client request, and a fight against
   `http-proxy`'s `selfHandleResponse`.
2. Both libraries violate the contract by default (`Connection: close`; `Trailer`), so
   adopting one means overriding its core request path anyway.
3. This listener is the security boundary for a remote-code-execution UI; adding two to
   three transitive packages to it is a worse trade than ~200 lines of Node.
4. The repo already tests a raw-socket relay with `node:test` and no dependencies
   **[repo]** `scripts/dsh-web-relay.test.cjs`; the proxy tests can follow the same shape.

If a library is mandated, use `http-proxy-3` (maintained, Node-22+, better abort handling)
with `changeOrigin: false`, `xfwd: false`, an explicit keep-alive `agent`, and contract
tests for `Connection`, `Trailer`, `Set-Cookie`, and abort.

### 9.3 Techniques that make built-ins faithful (verified on Node 24.22.0)

- `req.rawHeaders` preserves duplicate field names, original casing, and order; `req.headers`
  collapses duplicates (`Cookie` with `"; "`, others with `", "`) **[exp]**.
- `http.request({ headers: [...] })` accepts a **flat array** of raw header pairs and
  preserves duplicates/case **[exp]**; so does `res.writeHead(status, [...])` **[exp]**.
  This gives near-byte header fidelity in both directions without a library.
- `set-cookie` survives as an array through both APIs **[exp]**.
- `Expect: 100-continue` works end to end with this shape: the proxy's server auto-answers
  `100`, the body flows, upstream sees the header, no stall **[exp]**.
- Forwarding a client `Transfer-Encoding: chunked` header in the array is accepted and does
  not double-chunk **[exp]**.
- Strip at most `connection`/`keep-alive`/`proxy-connection` (re-derived) and keep
  `content-length`/`transfer-encoding` as received. Do not strip `trailer`.
- For upgrades: on `server.on('upgrade')`, dial `127.0.0.1:3080` with `net.connect`, write
  `"${req.method} ${req.url} HTTP/1.1\r\n" + rawHeaders + "\r\n"`, unshift the `head` bytes,
  then `pipe` both directions with `allowHalfOpen`. This relays DSH's `101` (including
  `Sec-WebSocket-Accept`) and its plain-HTTP `401`/`403`/`409` rejections without parsing
  either. Track sockets and destroy both on any close/error, exactly like the current relay
  **[repo]** `scripts/dsh-web-relay.cjs:36-63`.
- Timeouts: Node 24 server defaults are `requestTimeout 300000`, `headersTimeout 60000`,
  `keepAliveTimeout 5000`, `timeout 0` **[exp]**. Do not impose a shorter response timeout
  (it would kill SSE) and do not lower `requestTimeout` below DSH's own 300 s for large
  uploads. Disable timeouts on upgraded sockets.

---

## 10. Invariants

Each one is testable; the test IDs in §11 refer back to these.

| # | Invariant |
| --- | --- |
| I1 | `Host` reaches DSH verbatim on every request, including the token retry. |
| I2 | `Origin` and `Sec-Fetch-*` reach DSH verbatim. |
| I3 | Request `Cookie` is byte-identical; `Set-Cookie` values are byte-identical, ordered, and never joined. |
| I4 | The only rewritten request is `GET /` → `GET /…&token=…`, at most once, only on `401`, only with no `token` already present. |
| I5 | Method, raw path (including percent-encoding), query (except the appended token), and body bytes are unchanged. |
| I6 | Status, reason-independent semantics, and every end-to-end header are unchanged; only §5 deviations occur. |
| I7 | No header is added, dropped, or rewritten beyond §5; in particular no `Via`, `Server`, `X-Forwarded-*`, `Accept-Ranges`, `Content-Encoding` change, or `Secure` on cookies. |
| I8 | Bodies are never buffered for uploads/downloads/streams; backpressure is preserved. |
| I9 | Long-lived responses (SSE, WS) are not timed out, not buffered, and deliver their first byte promptly. |
| I10 | Client disconnect destroys the upstream request/socket, so DSH's bridge aborts the handler and generation. |
| I11 | Upgrades are relayed at the byte level after the request line: any status (101/401/403/409), any headers, binary frames, half-close. |
| I12 | Upstream failure before headers → a defined `502`; failure after headers → destroy the client socket, never a fabricated success. |
| I13 | The proxy listens only on the one concrete container IP and dials only `127.0.0.1:3080`. |
| I14 | The launch token is never logged, echoed, or placed in a response; an unknown/stale token degrades to passthrough. |
| I15 | No caching, no retry of non-idempotent requests, no redirect rewriting, no HTML/URL rewriting. |

---

## 11. Test matrix

### A. Proxy contract tests (`node:test`, no Docker, fake upstream)

A fake upstream must replay the exact DSH responses from Appendix A. Each test names the
invariant it proves.

| ID | Scenario | Assertion | Inv. |
| --- | --- | --- | --- |
| A1 | `GET /api/x` with JSON body, custom `Host`, `Origin`, `Cookie`, `X-Trace` | upstream sees identical raw header values; client sees identical status/body/headers | I1–I3, I5, I6 |
| A2 | `GET /` → upstream `401` | proxy retries once with `token`; client gets the `303`, `location: ./`, `Set-Cookie` byte-identical; upstream saw the original `Host` on **both** requests | I1, I3, I4 |
| A3 | `GET /` → `401`, retry also `401` | exactly 2 upstream requests; client gets the buffered `401` (status, `content-type`, body) | I4, I12 |
| A4 | `GET /?token=stale` → `401` | exactly 1 upstream request; `401` passthrough (no loop) | I4 |
| A5 | `HEAD /`, `GET /index.html`, `POST /`, `GET /?foo=1` → `401` | `HEAD`/`/index.html`/`POST` not retried; `/?foo=1` retried with both params; paths/methods unchanged | I4, I5 |
| A6 | No token configured, `GET /` → `401` | 1 request, `401` passthrough | I4, I14 |
| A7 | `GET /` with valid cookie → `200` | bytes equal; no retry | I5, I6 |
| A8 | Token passed in URL, then check logs/response | token absent from every log line, header, and `Location` | I14 |
| A9 | Multiple `Set-Cookie` from upstream | both values arrive, separate, in order | I3 |
| A10 | gzip response with `Content-Encoding: gzip`, `Vary` | body bytes identical (not decompressed), headers identical, `Content-Length` framing consistent | I6, I7 |
| A11 | Request with `Accept-Encoding: br, gzip` | upstream sees exactly `br, gzip`; proxy adds nothing | I6 |
| A12 | `POST` chunked 32 MiB upload, slow reader | upstream receives all bytes; proxy RSS stays bounded; backpressure (no full buffering) | I8 |
| A13 | 100 MiB download with `Content-Disposition` | bytes identical, streamed (first byte before last write), no buffering | I8 |
| A14 | Client aborts mid-upload and mid-download | upstream request socket destroyed within 1 s; no unhandled error | I10 |
| A15 | `GET /plugins/events` SSE | `content-type: text/event-stream` preserved; first `data:` frame arrives < 250 ms; connection survives 10 s idle; abort closes upstream | I9, I10 |
| A16 | WS `/api/remote.mux`: 101 + echo, 1 MiB binary frame each way | client sees upstream's exact `101` headers (incl. `Sec-WebSocket-Accept`); binary round-trip identical; `Sec-WebSocket-Protocol` preserved | I11 |
| A17 | WS upgrade with no cookie → upstream `401` + `Connection: close` | client receives the plain HTTP `401` bytes and a clean close (not a hang, not a WS frame) | I11 |
| A18 | WS client kills socket abruptly | upstream socket destroyed; no leaked listeners | I10, I11 |
| A19 | `Range: bytes=0-99` on an asset | upstream sees `Range`; response is the unmodified `200` full body; no `Accept-Ranges`/`Content-Range` added | I5, I7 |
| A20 | `Expect: 100-continue` upload | client receives `100`, then the final response; body intact | I6 |
| A21 | Client sends `Connection: close` | upstream sees `Connection: close`; the client socket closes after the response and cannot be reused | I6 |
| A22 | Keep-alive: 20 sequential requests on one client socket | all succeed; upstream reuse policy does not surface `ECONNRESET` | I6 |
| A23 | Upstream down / killed mid-response | `502` before headers; socket destroy after headers; proxy survives and serves the next request | I12 |
| A24 | `GET /browser-desktop/state`, `POST /browser-desktop/open` with same-origin and cross-origin `Origin` | same-origin `200`; cross-origin `403` **from the plugin**, proving `Origin`+`Host` arrived intact | I1, I2 |
| A25 | `Host: 172.18.0.2:3080` → `GET /api/…` | `403` from DSH's fence passed through unchanged (proxy must not "fix" it) | I2, I6 |
| A26 | Two concurrent `GET /` → `401` | both end with a usable cookie; no interleaved/corrupt responses | I4 |

### B. Image integration (Docker; extend `scripts/smoke.sh` / `scripts/lan-smoke.sh`)

| ID | Scenario | Assertion |
| --- | --- | --- |
| B1 | Fresh container, `GET /` through the published port | **decide**: either `401` (retry disabled) or `303` + cookie + `200` index (retry enabled); assert the chosen one |
| B2 | Open the printed tokenized URL | `303` → index renders; `window.__DSH_BOOT__` includes `@runzhliu/dsh-browser-desktop` (already asserted **[repo]** `scripts/smoke.sh:233`) |
| B3 | Browser-equivalent flow | create a session, send a message, receive streamed output over `/api/remote.mux` (proves WS through the proxy under real traffic) |
| B4 | `/plugins/events` | SSE connects and the initial `graph` frame arrives; the stream survives 60 s idle |
| B5 | `/api/session.export?sessionId=…` | ZIP downloads and opens; byte length equals the direct-loopback download |
| B6 | Upload a 50 MiB file via the attachment UI | succeeds; container memory stable |
| B7 | Restart the container | old browser cookie still authenticates (secret persists); if retry is enabled, a cookieless client re-authenticates with the **new** token; stale-token passthrough yields `401`, not a loop |
| B8 | LAN overlay | `https://host:8443` behind Basic Auth still works end to end, including noVNC WS and DSH cookie marked `Secure` |
| B9 | Listener boundary | still exactly two listeners on 3080: DSH on `127.0.0.1` and the proxy on one concrete address (existing `/proc/net/tcp` check **[repo]** `scripts/smoke.sh:238-245`) |

### C. Existing checks that must change (if the retry ships)

| ID | Location | Why |
| --- | --- | --- |
| C1 | **[repo]** `scripts/smoke.sh:219-224` | asserts `401` through the published port |
| C2 | **[repo]** `scripts/lan-smoke.sh:106` | asserts `401` through Caddy |
| C3 | **[repo]** `README.en.md:482`, `README.md:484`, `README.en.md:492` | documents `401` as the acceptance criterion for the unauthenticated root |
| C4 | **[repo]** `SECURITY.md:9-11`, `README.en.md:103,111-113,162` | describes the launch token as an access boundary |

Keep the loopback `401` assertions: `docker exec … 127.0.0.1:3080` and the Compose
healthcheck both bypass the proxy and remain valid **[repo]** `compose.yaml:42`.

---

## 12. Failure modes to guard

| Symptom | Cause | Guard |
| --- | --- | --- |
| Login loops forever, `401` on every `/api` | retry rewrote `Host`, minting a cookie for the wrong authority | A2 asserts `Host` on both requests; §3.2 |
| GUI loads but every call is `403` | browser reached an authority DSH does not trust (e.g. container IP without `--trusted-host`) | A25; document `--trusted-host` for any non-loopback authority |
| SSE/HMR stalls | response buffered, or a proxy response timeout | A15; no response timeout; `flushHeaders` |
| WS connects then dies after upgrade | proxy treated the 101 as an HTTP response, or rewrote `Sec-WebSocket-*` | A16, A17; raw pipe |
| WS never connects, socket hangs | unauthenticated upgrade rejection (`401` HTTP response) not relayed | A17 |
| Generation keeps running after the user closes the tab | abort did not destroy the upstream request | A14, A18 |
| `ECONNRESET` on idle tabs | upstream keep-alive idle (5 s) races the agent's free-socket reuse | A22; keep-alive agent with a shorter idle or one safe retry for idempotent GETs |
| 413 mid-upload never reaches the client | DSH closes while the client still uploads; proxy must stop forwarding and relay the `413` | A12 variant with `Content-Length > 300 MiB` |
| Token in logs | retry URL logged | A8; never log query strings for `/` |
| Proxy works until DSH restarts | token cached at startup | B7; refresh on each new `dsh web:` line; passthrough when stale |

---

## 13. Open questions for the ticket owner

1. **Token source** (§7): option A (proxy owns stdout) or B (entrypoint token file)?
   This decides the entrypoint diff and the supervision model.
2. **Ship the retry by default?** (§8) If yes, the repo's security documentation and C1–C4
   must change in the same PR; if no, the flag name and default must be documented.
3. **Should the retry be limited to loopback `Host`** so the LAN/Caddy path keeps the
   token boundary?
4. **Upstream keep-alive policy**: keep-alive agent (fewer sockets, `ECONNRESET` race) or
   `Connection: close` (simple, matches http-proxy's default)? The contract allows either;
   the tests differ (A22).
5. **Where do the new tests live**: `scripts/dsh-web-proxy.test.cjs` for A-series, or a new
   `test/` directory with a shared fake-DSH fixture?

---

## Appendix A — response transcripts the fake upstream must replay

Derived from source; framing as Node 24.22.0 emits it **[exp]**. Node appends
`Date`, `Connection`, and `Keep-Alive` when the handler does not set them; they are omitted
from the transcripts below.

**A.1 Unauthenticated index (`GET /`, `HEAD /`)**

```
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: text/plain; charset=utf-8
transfer-encoding: chunked

dsh web authentication required; reopen the URL printed by dsh web.\n
```

(68 bytes; `HEAD` has empty body.)

**A.2 Successful token exchange (`GET /?token=…`)**

```
HTTP/1.1 303 See Other
cache-control: no-store
location: ./
referrer-policy: no-referrer
set-cookie: dsh-auth-<base64url sha256(authority)>=v1.<payload>.<sig>; Max-Age=2592000; Path=/; Expires=<http-date>; HttpOnly; SameSite=Strict
```

**A.3 Rejected WS upgrade** (raw HTTP on the upgraded socket)

```
HTTP/1.1 401 Unauthorized
Connection: close
Content-Type: text/plain; charset=utf-8
Content-Length: 12

unauthorized
```

**A.4 SSE connect**

```
HTTP/1.1 200 OK
content-type: text/event-stream
cache-control: no-cache
connection: keep-alive
transfer-encoding: chunked

: connected\n\n
data: {"type":"graph",…}\n\n
```

**A.5 Gzip asset** (`accept-encoding: gzip`, compressible, length ≥ 1024)

```
HTTP/1.1 200 OK
content-type: text/javascript; charset=utf-8
content-encoding: gzip
vary: Accept-Encoding
transfer-encoding: chunked        # compression removes Content-Length
```

**A.6 Streaming ZIP** (`GET /api/session.export?sessionId=…`)

```
HTTP/1.1 200 OK
content-type: application/zip
content-disposition: attachment; filename="…"
transfer-encoding: chunked
```

## Appendix B — sources

DSH package sources (version `0.2.1-rc.2`, resolved under
`/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`):

- `dsh-client-connection/lib/index.js`: `14` (`/api`), `19` (`/connect`), `30` (300 MiB),
  `40-110` (bridge), `127-137` (loopback), `201-269` (trust fence), `276-355` (token,
  cookie name/attrs), `380-405` (`authenticate`), `414-577` (`BrowserAuth`, `authorizeIndex`,
  `writeUnauthorized`), `742-757` (`admit`), `1046-1066` (routes).
- `dsh-client-connection/README.md`: transport, trust, cookie, and generation sections.
- `dsh-host-webserver/lib/index.js`: `196-225` (gzip filter, SSE/`Content-Range`
  exclusions), `325-390` (register/upgrade/fallback), `377-500` (listener, upgrade handler).
- `dsh-host-webserver/README.md`: routes, matching order, compression, failure behavior.
- `dsh-host-frontend-static/lib/index.js`: `49-99` (index auth, static, traversal, 405).
- `dsh-api-gateway/lib/index.js`: `133` (mux path), `300` (`WebSocketServer`),
  `680-691` (upgrade rejection), `780-822` (upgrade route).
- `dsh-client-hmr/lib/index.js`: `5` (`/plugins/events`), `124-152` (SSE headers).
- `dsh-client-modules/lib/index.js`: `202` (`/plugins`), `564-568`, `985-986` (immutable).
- `dsh-client-file-upload/lib/index.js`: `72`, `168-175`.
- `dsh-session-log-export/lib/index.js`: `488`, `516-524`, `558-563`.
- `dsh-host-open-in-app/lib/index.js`: `1126-1132`, `1263-1318`, `:1320`.
- `dsh-deepseek-account-platform/lib/index.js`: `992-1010`.
- `dsh-web-app/lib/index.js`: `156-166` (URL print), `38-39` + `:145-150` (`DSH_WEB_URL`);
  `dsh-web-app/cordis.patch.yml`: `186-188` (gzip), `197-203` (`printUrl`), `232-241`
  (`connection` trust comment).
- `dsh-web-app/startup.js`: `--trusted-host`, `--public-url`, `--host`, `--port`.

This repository:

- `scripts/dsh-web-relay.cjs`, `scripts/dsh-web-relay.test.cjs` — current relay and its tests
  *(retired by #13; see the errata above and `scripts/dsh-web-supervisor.cjs`)*.
- `scripts/deepseek-harness-entrypoint:191-194` — relay/DSH supervision.
- `web.cordis.patch.yml`, `web.market.cordis.patch.yml` — composition overrides.
- `compose.yaml:12,42`, `compose.lan.yaml`, `config/Caddyfile.lan`.
- `scripts/smoke.sh:203-245`, `scripts/lan-smoke.sh:100-200`.
- `SECURITY.md:9-11`; `README.en.md:103-113,162,175,482,492`; `README.md:111-113,174,484`;
  `Dockerfile:374` (default Web command).

Third-party:

- `http-proxy@1.18.1`: <https://registry.npmjs.org/http-proxy>,
  `lib/http-proxy/common.js:43,73`, `passes/web-incoming.js:150-190`,
  `passes/web-outgoing.js:42-118`, `passes/ws-incoming.js:81-150`.
- `http-proxy-3@2.0.1`: <https://registry.npmjs.org/http-proxy-3>,
  <https://github.com/sagemathinc/http-proxy-3> (README status section),
  `dist/lib/http-proxy/common.js:22,82-88,113-114`,
  `dist/lib/http-proxy/passes/web-incoming.js:139-180`.
- `httpxy@0.5.5`: <https://registry.npmjs.org/httpxy>.
- Node.js HTTP docs (server/client defaults and header handling):
  <https://nodejs.org/api/http.html>. Default values were confirmed on `v24.22.0` with
  `http.createServer()` / `http.globalAgent` rather than trusted from prose.
