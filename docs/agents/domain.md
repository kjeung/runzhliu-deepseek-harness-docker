# Domain Docs

**Layout: single-context.** This repo keeps one `GLOSSARY.md` at the repo root, with architecture decisions in `docs/adr/`. There is no `GLOSSARY-MAP.md` and no per-subproject `GLOSSARY.md`; those appear only if the repo later splits into separate contexts.

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root. If a `GLOSSARY-MAP.md` appears later, read it first and then each `GLOSSARY.md` it points at that is relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/            # 0001-token-capture-supervisor.md, 0002-admin-version-policy.md
│   └── research/       # dated upstream/runtime investigation notes
├── charts/deepseek-harness/
├── compose.yaml        # plus the market, bwrap and podman overlays
├── Dockerfile          # plus Dockerfile.market and Dockerfile.bwrap
└── scripts/
```

Multi-context layout is **not in use here**. It would look like a root `GLOSSARY-MAP.md` pointing at one `GLOSSARY.md` per context, each with its own `docs/adr/`; adopt it only when the repo actually grows separate contexts.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (admin version policy), but worth reopening because…_
