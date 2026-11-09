# Crabhelm (valkyriweb fork)

This fork holds two things:

- **Crabhelm**, the upstream control plane (`openclaw/crabhelm`): `src/`, `worker/`, `aws/`, `web/`, `deploy/`. Start with `README.md`.
- **agent-run**, fork only: `agent-run/`. It runs one agent turn off the laptop: `node agent-run/bin/agent-run.mjs --harness pi --prompt-file task.md`.

## agent-run

`agent-run` runs one non-interactive harness turn: `pi`, `codex`, `claude`, `openclaw`, `rusty`, `grok` or `prime`.
It asks Harbor capacity placement first. On `local` the turn runs on the laptop. On `remote` or `queue` it runs on a Crabbox broker lease.

```sh
node agent-run/bin/agent-run.mjs --harness <name> --prompt-file F [--model M] [--thinking T] [--attach FILE]... [--out DIR] [--placement auto|local|remote] [--placement-decision FILE] [--pi-context-file FILE]
node agent-run/bin/agent-run.mjs place --harness <name> [--run-id ID]   # print the placement decision only
node agent-run/bin/agent-run.mjs appliance build <harness>              # build the pinned harness bundle that leases unpack
node agent-run/bin/agent-run.mjs sweep                                  # revoke keys left by a killed run
```

- Exit code: the harness exit code. `75`: no capacity; retry later. `3`: agent-run failed. `4`: key revocation is not proven. `place` exits `2` when the check fails.
- Output: `--out DIR` (default `./agent-run-<run id>`) holds `session/` and `receipt.json`. The receipt records placement, target lease, exit code and key revocation proof.
- Defaults (provider `serve`, type `cpu2`, kube context `lue-kube`) and their `AGENT_RUN_*` overrides: `agent-run/lib/config.mjs`.
- Credentials: agent-run makes one ClawRouter key per run and revokes it when the run ends. Never print, log or store a key. Rules: `docs/agent-run/credentials.md`.
- Placement contract: `~/Projects/personal/harbor/docs/capacity-placement.md`.
- Design: `docs/agent-run/design.md`. Pi child context: `docs/agent-run/pi-context.md`.

## Commands

| Change | Run |
|---|---|
| `agent-run/` | `pnpm agent-run:test` |
| Node domain code (`src/`, `tests/*.test.ts`) | `pnpm test` |
| Worker and Durable Objects (`worker/`, `tests/workers/`) | `pnpm test:workers` |
| AWS adapter (`aws/`, `tests/aws/`) | `pnpm aws:check` |
| Before every PR | `pnpm check` (build, type checks and all four suites) |

## Fork rules

- PRs target `valkyriweb/crabhelm`. In a fork `gh` defaults to the parent repo, so pass `--repo valkyriweb/crabhelm` on every `gh pr` command.
- Never push to `upstream` (`openclaw/crabhelm`).
