# Token capture belongs to a DSH supervisor that owns the `dsh` child

DSH exposes its launch token only on stdout, per process, with no config seam. Instead of extracting it to a file, the container's proxy spawns `dsh` itself, mirrors its output line-by-line into the container log, and holds the token in memory bound to that pid; the same supervisor serves the default and admin images, so a version switch recaptures the token through one path (decision record: [#12](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/12)).

- **Status:** accepted, 2026-10-21
- **Considered options:** tee the token to a `0600` file rejected — a `/bin/sh` pipeline breaks the entrypoint's `$!`/signal model and adds a second copy of a bearer credential without adding capability. Manual `?token=` only rejected — it fails the auto-bootstrap goal.
- **Consequences:** DSH supervision moves from the entrypoint's `$!` model to a child process that owns `dsh`; `docker logs` must stay byte-compatible for operators and smoke tests; capture failure degrades to the manual `?token=` path, never to "no auth" ([#8](https://github.com/kjeung/runzhliu-deepseek-harness-docker/issues/8)).
