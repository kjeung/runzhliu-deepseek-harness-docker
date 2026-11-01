# AGENTS.md

Guidance for coding agents working in this repository.

## Publication policy

**This repository publishes no container images.** Images are built locally
from the Dockerfiles and pushed to no registry. See `CONTRIBUTING.md` for the
policy and `scripts/check-version-consistency.sh` for how `make verify` enforces
it. Do not add publish steps, registry credentials, or `push: true` build
actions.

## Before changing anything

- `GLOSSARY.md` — the project's domain vocabulary. Use its terms; the file
  records which synonyms to avoid.
- `docs/adr/` — architecture decisions that constrain the area you are touching.
- `CONTRIBUTING.md` — the rules a pull request must satisfy, including the
  cross-file version pins, the web security posture, and the screenshot refresh
  expectation on upstream upgrades.

## Issue tracker

Issues and specifications live in this repository's GitHub Issues. See
`docs/agents/issue-tracker.md` for the conventions (create, read, claim,
resolve, and the wayfinding map/child-ticket operations).

## Triage labels

The five canonical triage roles use their default label strings:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md` for the role-to-label mapping.

## Verification

`make verify` covers Compose and Helm rendering, the plugin unit tests, and the
cross-file version consistency check. Docker-dependent verification (image
build, `make smoke`, the variant smokes) needs a Docker-capable host; when one
is available, prefer a single-architecture pass first because a full
Debian+Chromium build is memory-hungry. Maintainers hold the connection details
for the dedicated test host outside the repository.

## Domain docs

This repo uses a single-context layout: one `GLOSSARY.md` at the repo root, with
architecture decisions in `docs/adr/`. See `docs/agents/domain.md` for how the
engineering skills should consume these.
