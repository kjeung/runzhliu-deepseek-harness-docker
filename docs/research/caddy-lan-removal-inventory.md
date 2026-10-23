# Caddy/LAN removal and the 401 assumptions — repo inventory

Change inventory for wayfinder ticket [`#11`](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/11)
(task output; this is repository inspection, not external research).

- **Base:** `main` @ `a9b0051` (2026-10-24). Line numbers are that commit's.
- **Scope:** hard-delete the in-repo Caddy/LAN security layer, and list every place that
  assumes `GET /` answers `401` once the published port auto-exchanges the launch token.
- **Not scope:** implementation code, Host/Origin policy (ticket #9), failure UX (#8),
  legacy DSH versions (#10), proxy HTTP semantics (research #4).

## Reused notes

| Note | One-line conclusion | What it does not answer |
| --- | --- | --- |
| [`dsh-proxy-contract.md`](dsh-proxy-contract.md) §8, §11.C, §10.B | The server-side token retry turns `GET /` on the published port into `303` + `Set-Cookie` → `200`; loopback checks keep `401`; it lists **four** affected sites (C1–C4). | The full file/target/doc set this ticket asks for. |
| [`dsh-token-lifecycle.md`](dsh-token-lifecycle.md) §4, §7 | Exchange contract: exactly one 43-char token on `GET /` → `303 ./` + authority-bound cookie; everything else stays `401`. | Repo inventory. |
| [`ADR-0001`](../adr/0001-token-capture-supervisor.md) | A supervisor owns `dsh`, holds the token in memory, and shares the process with the future proxy. | The removal work. |

A fresh `/research` pass was not needed: no question here is answered outside this
repository, and the two notes above already fix the HTTP contract. What was missing was a
repo-wide enumeration of every touched site, produced below.

## The classification rule

| Class | Meaning | Sites |
| --- | --- | --- |
| **KEEP** | The check hits DSH directly on container loopback; the proxy is not in the path. `401` stays correct. | `compose.yaml` healthcheck, the three Helm probes. (The smoke scripts' `docker exec` checks are readiness checks, not `401` assertions; they are unaffected either way.) |
| **FLIP** | The check hits the **published** port, where the proxy now answers `303` + `Set-Cookie` → `200`. | `scripts/smoke.sh`, `scripts/podman-smoke.sh`, README/SKILL operator commands, SECURITY.md prose. |
| **DELETE** | Caddy/LAN only. Nothing survives it. | `compose.lan.yaml`, `config/Caddyfile.lan`, `.env.lan.example`, `scripts/lan-smoke.sh`, `lan-*` targets, the CI `lan-gateway` job, the LAN doc sections. |

The two change sets are separable but share the same document rewrite, so the
recommendation is **one implementation issue / one squash commit** that ships
"proxy auto-login + Caddy removal + assertion/docs rewrite". Splitting them guarantees
rewriting README, SECURITY.md and SKILL.md twice. If they must split, do the **delete-only**
set first (it does not depend on the proxy) and leave every FLIP site asserting `401` until
the proxy lands.

## 1. Deleted files

| Path | Size | Contents to lose | Alive references to clean |
| --- | --- | --- | --- |
| `compose.lan.yaml` | 68 lines | `--trusted-host` command override, `lan-gateway` Caddy service, `dsh-lan-caddy-*` volumes, `DSH_DESKTOP_PUBLIC_PORT` override | `Makefile` L19/22/39-40/109-117/124-125/164-165; `check-version-consistency.sh` L54; CI `ci.yml` L72-90; `scripts/lan-smoke.sh`; README zh L113/215-242/518; README.en L113/216-243/519; SECURITY.md L11 |
| `config/Caddyfile.lan` | 38 lines | TLS internal CA, Basic Auth, `Secure` cookie rewrite, noVNC reverse proxy, `header_up -Authorization` | `compose.lan.yaml` bind mount; README zh L519; README.en L520; `dsh-proxy-contract.md` §3.2/§7/§11.C (historical) |
| `.env.lan.example` | 26 lines | `DSH_LAN_*`, bcrypt hash instructions, `CADDY_IMAGE`, LAN image overrides | `check-version-consistency.sh` **L63 and L64** (L64 is easy to miss); README zh L222/L520; README.en L223/L521; SKILL.md L40 |
| `scripts/lan-smoke.sh` | 207 lines | TLS/CA/BasicAuth/Secure-cookie/trusted-host/same-origin end-to-end test | `Makefile` L22/144/164-165; `ci.yml` L90; README zh L526; README.en L527; `dsh-proxy-contract.md` §11.C |

Also drop from `.gitignore`: `.env.lan` and `dsh-lan-root.crt` (no longer produced).
`.dockerignore` needs no change: none of these paths were ever in the build context.

**Salvage before deleting `scripts/lan-smoke.sh`.** These assertions test DSH or the
publication boundary, not Caddy, and should move into `scripts/smoke.sh`:

- untrusted `Origin` on `/api` → `403` (L154-162), trusted same-origin → not `403` (L144-152);
- versioned noVNC page same-origin → `200` (L164-182) and noVNC WebSocket upgrade → `101` (L183-198);
- native ports still bound to loopback (L200-205); already covered by `smoke.sh` L238-247
  and `podman-smoke.sh` L121-126;
- manual `?token=` exchange still works (already in `smoke.sh` L226-229).

Drop the rest: internal CA, Basic Auth challenge, `Secure` cookie rewrite, TLS 8443,
`--trusted-host` wiring (`DSH_LAN_HOST`).

## 2. Build, Makefile and CI (diff-level)

### `Makefile`

| Line | Operation |
| --- | --- |
| 15-16 | delete `CADDY_VERSION` / `CADDY_IMAGE` |
| 19 | delete `LAN_ENV_FILE ?= .env.lan` |
| 22 | `.PHONY`: delete `lan-up lan-down lan-logs lan-smoke` |
| 39-40 | delete the two `lan-*` help lines |
| 109-117 | delete `lan-up`, `lan-down`, `lan-logs` |
| 124-125 | delete the two `compose.lan.yaml` `compose config` lines |
| 144 | delete `bash -n scripts/lan-smoke.sh` from `plugin-check` |
| 154 | drop the 12th argument (`$(CADDY_VERSION)`) from `version-check` → 11 args |
| 164-165 | delete the `lan-smoke` target |

### `scripts/check-version-consistency.sh`

| Line | Operation |
| --- | --- |
| 15 | delete `caddy_version` positional (it is last; nothing renumbers) |
| 54 | delete the `compose.lan.yaml` Caddy literal |
| 63 | delete the `.env.lan.example` `CADDY_IMAGE` literal |
| 64 | delete the `.env.lan.example` `DSH_IMAGE_VERSION` literal (independent of Caddy) |
| 112 | delete the `README.md` `caddy:…` literal |
| 121 | delete the `README.en.md` `caddy:…` literal |
| 125 | delete the `SKILL.md` `caddy:…` literal |
| 133-134 | drop `caddy=%s` / `${caddy_version}` from the final printf |

Recommended additions (supplied by the proxy spec, not decided here): pin the new proxy
module in the image and its spawn line in the entrypoint, so a future merge cannot silently
drop the fork change. See #7 for the marker convention.

### `.github/workflows/ci.yml`

- Delete the whole `lan-gateway` job (L72-90) and its `CADDY_IMAGE=… ./scripts/lan-smoke.sh` step (L90).
- No new job is required: `manifests` runs `make verify` (which picks up the trimmed
  `compose-check` / `plugin-check` / `version-check`), and the `image` job's `smoke.sh`
  runs on both architectures and carries the new FLIP assertions. `podman-smoke.sh` runs in
  that same job for rootless coverage.
- **Coverage that disappears:** the only in-repo exercise of `--trusted-host`, TLS, and a
  non-loopback `Host` was the Caddy path. Do not fake a replacement here — the external
  proxy contract (and whether the image expects `--trusted-host` or loopback-Host rewriting)
  is decision ticket **#9**. Until #9 lands, the docs must not advertise a supported
  external-proxy recipe.
- Optional guard (recommended, feeds #7): a `make fork-check` target that fails when
  `compose.lan.yaml`, `config/Caddyfile.lan`, `.env.lan.example` or `scripts/lan-smoke.sh`
  exist again, or when `Caddy|compose.lan|lan-smoke` reappears in `Makefile`/`ci.yml`.
  Add it to `verify` so CI enforces the fork boundary after every upstream merge.

### Unchanged (verified, do not edit)

| File | Why |
| --- | --- |
| `compose.yaml` L42 | healthcheck fetches `127.0.0.1:3080` **inside** the container → still `401` (#13 comment, proxy contract §11.C) |
| `charts/deepseek-harness/templates/statefulset.yaml` L78/85/92 | startup/liveness/readiness probes hit pod loopback → still `401`; no chart change |
| `Dockerfile*`, `web.cordis.patch.yml`, `compose.podman.yaml`, `compose.market.yaml`, `compose.bwrap.yaml` | no Caddy/LAN references |
| `.env.example`, `.dockerignore`, `scripts/check-upstream-dsh.sh` | no LAN references |
| `.github/workflows/publish-dockerhub.yml`, `publish-ghcr.yml`, `upstream-dsh.yml` | no Caddy/LAN references (grep-verified) |
| `scripts/render-dockerhub-readme.sh` | anchors (`快速开始`, `Rootless Podman`, `浏览器桌面`, `文件`) survive the LAN-section deletion; only re-run `make dockerhub-check` for the 25 KB guard |

## 3. The `401` inventory (every site)

`grep -rn '401'` plus a manual read of every hit, excluding `.git` and binary assets.

| # | Site | Current assumption | Action |
| --- | --- | --- | --- |
| 1 | `compose.yaml:42` | healthcheck `web.status !== 401` fails | **KEEP** (container loopback) |
| 2 | `charts/…/statefulset.yaml:78,85,92` | three probes assert `401` | **KEEP** (pod loopback) |
| 3 | `scripts/smoke.sh:219-224` | published-port `GET /` must be `401` | **FLIP** |
| 4 | `scripts/smoke.sh:238-247` | `/proc/net/tcp` shows DSH loopback + one concrete listener | **KEEP semantics**, rename the "supervisor forwarder" comment to the proxy listener |
| 5 | `scripts/podman-smoke.sh:115` | rootless published port must be `401` | **FLIP** |
| 6 | `scripts/lan-smoke.sh:74,79,106` | Caddy path must reach `401` | **DELETE** with the file |
| 7 | `scripts/lan-smoke.sh:123,127-130,144-198` | TLS exchange/`Secure` cookie/Origin/noVNC/WS | **DELETE**, salvage Origin + noVNC + WS into `smoke.sh` |
| 8 | `SKILL.md:63` | operator runs `curl … = 401` on the published port | **FLIP** |
| 9 | `README.md:174` / `README.en.md:175` | "opening the root without a token returns `401`" | **FLIP** (auto-login; `?token=` stays as fallback) |
| 10 | `README.md:484` / `README.en.md:482` | smoke command asserts `401` | **FLIP** |
| 11 | `README.md:491` / `README.en.md:492` | acceptance criteria assert `401`; "TCP 中继" wording | **FLIP + reword** |
| 12 | `README.md:33,50,53,103,113,161-162,217-242,377-378,417-418,467,470,517-520,526` and the `README.en.md` mirrors (`33,50,53,103,113,162,216-243,378,418,463,466,519-521,527`) | LAN/Caddy/trusted-host claims; tokenized-URL onboarding; alpha.2 migration warning ("retains … the existing Caddy LAN gateway"); security table | **REWRITE** (see §4) |
| 13 | `SECURITY.md:9-11,17,19,23` | launch token + Caddy as the security story | **REWRITE** |
| 14 | `CHANGELOG.md:54,122,195` | historical entries describe the old model | **DO NOT rewrite history**; add an `## Unreleased` entry |
| 15 | `docs/research/*.md` (e.g. proxy contract §8, §11.C, §12) | research snapshots asserting the old model | **ANNOTATE** with an errata after the removal, same pattern as the 2026-10-24 #13 errata |
| 16 | `scripts/dsh-web-supervisor.test.cjs:90,105` | `(LAN: …)` **log-line** shapes from 0.1.2–0.2.1-alpha.1 | **FALSE POSITIVE** — token-print parsing, not HTTP; leave untouched |
| 17 | `GLOSSARY.md:21` | "Caddy" in the `Proxy` _Avoid_ list | keep (still correct usage guidance); no LAN term exists |

The FLIP target state (one sequence, per the contract):

1. fresh client, no cookie, `GET http://127.0.0.1:<published>/` → `303`, `Location: ./`,
   `Set-Cookie: dsh-auth-<authority>=…` (proxy did exactly one token retry);
2. same client with the cookie → `200` and the browser-desktop manifest present;
3. `GET /?token=<stale>` → `401` passthrough, exactly one upstream request (no loop);
4. `docker exec … 127.0.0.1:3080/` → still `401` (KEEP sites);
5. container listeners on 3080 → still exactly loopback + one concrete address.

`podman-smoke.sh:115` gets the same sequence (its cookie jar can reuse `smoke.sh`'s pattern).
`smoke.sh`'s existing manual `?token=` step (L226-229) stays as the fallback test — run it
after clearing the cookie jar so it proves the fallback rather than the auto-login.

## 4. Documentation rewrite

### `SECURITY.md`

- **L9** — replace "launch token … is the security story" with: the proxy completes the
  exchange for any client that can reach its listener, so the launch token is **not** an
  access boundary on that listener; the deployment boundary is network reachability plus
  whatever external reverse proxy/SSO the operator puts in front.
- **L11** — delete the Caddy/LAN paragraph. Replace with: the image publishes host
  loopback only; LAN exposure is the operator's external reverse proxy (TLS, SSO,
  Host/Origin alignment), contract in #9.
- **L17** — "The gateway does not make Harness multi-tenant" → the proxy does not either.
- **L19** — drop "Internet forwarding of the LAN gateway"; keep public exposure unsupported.
- **L23** — reword the listener paragraph: supervisor owns `dsh`; proxy shares the process,
  holds the token in memory, auto-exchanges once per cookieless `GET /`; still one concrete
  container address, never wildcard, never host networking.

### `README.md` / `README.en.md`

- Alpha.2 migration warning (`L33` zh / `L33` en): its last sentence promises the
  "existing Caddy LAN gateway"; replace with loopback-only plus external reverse proxy.
- Status table (`L50-53` zh / `L50-53` en): Web UI row → "default loopback; no in-container
  gateway; expose through an external reverse proxy".
- Security table (`L103`) and intro (`L161-162` / `L162`): remove "optional Caddy HTTPS +
  Basic Auth"; keep "noVNC unauthenticated, tools execute code".
- Listener paragraph (`L111`): forwarder → proxy; remove "for a later proxy exchange" once
  the proxy ships; keep the ambiguous-interface/`DSH_WEB_RELAY_INTERFACE` text until #9/#4
  rename the variable.
- Quick start (`L174` / `L175`): open `http://127.0.0.1:3080` directly — no token hunt;
  `?token=` remains the manual fallback; 401-on-root sentence goes away.
- Delete the whole LAN section (`L215-242` zh / `L216-243` en) and replace it with a short
  "external reverse proxy / SSO" section: image stays on loopback publication, the external
  proxy must preserve the browser `Host` (or the operator must add `--trusted-host` — pending
  #9), noVNC stays loopback-only.
- Plain Docker (`L377-378` zh / `L378` en) and Helm (`L417-418` zh / `L418` en): "open the
  tokenized URL" → "open the loopback URL; the proxy logs you in".
- Security-boundary bullets (`L467,470` zh / `L463,466` en): drop LAN gateway capability text;
  replace the LAN overlay bullet with the proxy/external-SSO boundary.
- Smoke block (`L483-488` zh / `L481-489` en): remove `make lan-smoke`; replace the `= 401`
  test with the 303→200 sequence (or `curl -L -o /dev/null -w '%{http_code}'` expecting 200).
- Acceptance criteria (`L491` / `L492`): "unauthenticated root returns `401`" → "published
  root auto-redirects and loads; container loopback stays `401`"; "TCP relay" → proxy listener.
- File table (`L513` / `L514`): update the supervisor row; add the proxy row when it exists;
  delete `compose.lan.yaml`, `config/Caddyfile.lan`, `.env.lan.example`, `scripts/lan-smoke.sh`
  rows (`L517-520,526` / `L519-521,527`).

### `SKILL.md` (agent-facing; the version checker pins it)

- L3 description: drop "optional protected LAN gateway"; mention automatic loopback login.
- L12: replace the `compose.lan.yaml` instruction with "no in-container gateway; never
  publish the native ports; external reverse proxy owns TLS/SSO".
- L32: drop the "Add `compose.lan.yaml` …" sentence and the Caddy version.
- L38-40: delete "Enable protected LAN access" entirely; replace with a short "Behind an
  external reverse proxy" section (loopback publication, Host preservation, #9 pending).
- L63: assertion → auto-login (see §3).

### `CHANGELOG.md`, `CONTRIBUTING.md`, `GLOSSARY.md`, `docs/adr/`

- `CHANGELOG.md`: add `## Unreleased` bullets for the removal, the auto-login model, the
  assertion rewrite and the deleted targets. Never edit released entries.
- `CONTRIBUTING.md` item 2: add "no in-container auth/TLS gateway; an external proxy owns
  transport security and SSO".
- `GLOSSARY.md`: optional; if edited, record that "gateway"/"Caddy" are retired and
  "external reverse proxy" is the new term (#9 may settle it).
- `docs/adr/`: add **ADR-0002** "Caddy/LAN security layer removed; security externalized"
  (Q6=A), in ADR-0001's format, status accepted when the implementation lands.
- `docs/research/dsh-proxy-contract.md`: add an errata line after the removal pointing here;
  keep the 2026-10-20 evidence untouched.

## 5. Conflict risks against Q5=B (in-place fork)

Evidence from this repo's own release history: the routine upgrade commit `52f7907`
("upgrade DSH to 0.2.1-rc.2") touched `.env.lan.example`, `scripts/lan-smoke.sh`,
`.github/workflows/ci.yml`, the publish/upstream workflows, `Makefile`, `.env.example`,
`README.md`, `README.en.md`, `SKILL.md`, `CHANGELOG.md`, the version pins in the
Dockerfiles/compose/chart files, and all four smoke scripts (`smoke.sh`, `podman-smoke.sh`,
`lan-smoke.sh`, `bwrap-smoke.sh`). The previous upgrade commits (`cb5aadd`, `7377f72`) bump
the same LAN files. Expect this every upstream release.

| Risk | Files | Merge behavior | Mitigation |
| --- | --- | --- | --- |
| Deleted-by-us, edited-by-them | `.env.lan.example`, `scripts/lan-smoke.sh` (both bumped every release), `compose.lan.yaml` (last touched by Podman support `bdabebe`), `config/Caddyfile.lan` | `CONFLICT (modify/delete)` on every release | keep deleted (`git rm`); playbook step: re-run the deletion check after merge |
| Upstream adds new LAN/Caddy files (e.g. another overlay) | new paths | merges silently, reintroduces the layer | `make fork-check` file/literal scan (#7 gate) |
| Same-file edits in high-churn regions | `Makefile` (CADDY_* block, version bump lines), `ci.yml` (job list), `README*` (upgrade text and version strings), `SKILL.md`, `smoke.sh`, `podman-smoke.sh` | textual conflict or silent loss of our hunk | small colocated hunks; `# fork:` / `<!-- fork: -->` markers; concentrate new logic in new files (`scripts/dsh-web-proxy.cjs` + test) so the entrypoint diff stays a few lines |
| Version checker drift | `check-version-consistency.sh` (Caddy arg + 7 literals) | this file is rarely touched by upgrades, but every `CADDY_VERSION` bump in `Makefile` collides with its removal | delete all Caddy literals; add fork literals per the proxy spec |
| New `401` assumptions upstream | `compose.yaml`, `charts/…/statefulset.yaml`, new health checks | could invalidate the KEEP/FLIP split silently | post-merge scan `grep -rn '401' compose.yaml charts/ scripts/`; classify any new site against §3 |
| Upstream changes healthcheck semantics (e.g. `302`/`200`) | `compose.yaml`, probes | our KEEP sites assume `401`; a changed upstream assertion needs re-deciding | same scan; playbook must list it |
| Upstream later removes LAN itself | all four deleted files | clean (delete/delete) | nothing to do; drop the guard rule |
| Rollback | the whole fork change set | — | ship as one squash commit so `git revert` is atomic |

## 6. Dependencies and open items handed off

- **#9 (Host contract)** — deleting `compose.lan.yaml` removes the only in-repo
  `--trusted-host` configuration. Any external proxy serving a non-loopback authority needs
  `--trusted-host` (or a Host rewrite); that is #9's decision, so the docs here must not
  promise a supported external-proxy recipe yet.
- **#4 (proxy contract)** — supplies the FLIP mechanics, the proxy module, and its tests.
- **#8 (token failure UX)** — what the operator sees when no token is available; the
  `token-timeout` state already exists (#13).
- **#10 (version range)** — legacy DSH ≤ `0.1.1-rc.2` answers `200` on `/` with no token, so
  the FLIP sequence must not be asserted for legacy images.
- **#7 (merge playbook)** — this inventory is its input (files, hot spots, markers, gate).
  It stays blocked until this ticket closes.
- **Kubernetes** — probes unchanged, but `kubectl port-forward` now reaches the proxy and
  auto-logs in; docs only, no chart change.
- **Docker Hub overview** — README shrinks; re-run `make dockerhub-check` (25 KB floor).

## 7. Acceptance self-check

| Ticket requirement | Where |
| --- | --- |
| Exact list: `compose.lan.yaml`, `config/Caddyfile.lan`, `.env.lan.example`, `scripts/lan-smoke.sh`, Makefile `lan-*`, README sections, `charts/` refs, CI workflow | §1, §2, §4; charts explicitly verified unchanged (§2) |
| Every place assuming `/` returns `401`, incl. `compose.yaml` healthcheck, `scripts/smoke.sh`, `scripts/podman-smoke.sh`, `scripts/lan-smoke.sh`, README | §3 (17 classified sites; false positives named) |
| Makefile/CI targets to add or modify | §2 (`Makefile` table, `check-version-consistency.sh`, CI job deletion, optional `fork-check`; no new job needed) |
| Q5=B conflict risks | §5 (evidence-backed by `52f7907`/`cb5aadd`/`7377f72`) |
| Diff-level only, no implementation code | this document only; no source files changed |
| Salvage value before deletion | §1 salvage list (Origin fence, same-origin noVNC, WS upgrade, loopback binding) |
