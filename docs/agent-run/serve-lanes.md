# Donate a Herdr lane to Crabbox Serve

Herdr Core (`hc`) and Herdr App manage the machines and interactive sessions.
Crabbox manages Linux container leases, even when the host is a Mac. An `hc`
connection is not a Crabbox login or proof of spare capacity. No Kubernetes
resources are needed, and this does not replace or change any kube donor.

The selectors below are opt-in. The existing DL360 default does not change.
Do not register a donor until the operator has approved its broker identity.

| Herdr machine | Crabbox `serve --name` | Lease type | Minimum offer for one lease |
| --- | --- | --- | --- |
| `agent-runner` | `agent-runner-hc-serve` | `cpu2` | `--cpus 2 --memory 4g` |
| `asus-laptop-1` | `asus-laptop-1-hc-serve` | `cpu2` | `--cpus 2 --memory 4g` |
| `lue-and-naddy-mbp-old` | `lue-and-naddy-mbp-old-hc-serve` | `cpu4` | `--cpus 4 --memory 8g` |
| `lue-and-naddy-server` (Mac mini, not the DL360) | `lue-and-naddy-server-hc-serve` | `cpu1`, light only | `--cpus 1 --memory 2g --max-leases 1` |

Keep these names unique in the broker inventory. In particular, use the
`-hc-serve` names for non-kube donors so that a lease never targets the kube
donor by display name. Do not pin a donor or use its spare capacity while it is
sharing the same CPU and memory budget with another donor on the same machine.

## Prepare the host, then stop at broker authentication

1. On a Linux x86-64 host, install the pinned CLI as the intended donor user
   using [`agent-run/bin/install-crabbox-linux.sh`](../../agent-run/bin/install-crabbox-linux.sh).
   It verifies the release archive before extraction, keeps its runtime pack
   with the binary, and links the binary in `~/.local/bin`. It needs Bash, GNU
   core utilities, tar and curl, not sudo. It never logs in, touches an
   unmanaged Crabbox binary, or starts a service. Use the corresponding
   [pinned Crabbox release](https://github.com/valkyriweb/crabbox/releases/tag/v0.79.1-valky.11)
   for a Mac where the client isn't already installed.
2. On the host, have a working Docker (including OrbStack on macOS) or Podman
   Linux-container runtime accessible to the donor user. Use a native guest
   architecture, keep a private persistent Serve state directory, and make
   sure the host can reach the coordinator. Keep the default availability
   checks on. Linux laptops may report unknown console idle; use
   `crabbox serve status --probe --json` to assess that on the host rather than
   turning off availability gating to force a lease. Plan existing work and
   the kube donor offer before donating the same hardware.
3. **Operator step (Luke):** Pick the Serve-enabled broker owner and organization
   that will also dispatch these leases. Verify its exact owner ID belongs in
   the broker's `CRABBOX_SERVE_ALLOWED_OWNERS` list (not `*`). As the donor service
   user, run `crabbox login --url <approved-coordinator-url>` on each approved
   host and complete its same-device browser login. The client on the dispatch
   host must log in to the same coordinator as the same owner in the same org.
   For a headless host without a same-device browser, provision that same
   owner-scoped **Crabbox coordinator bearer credential** through the approved
   secret store for that service user. Crabbox supports a broker token helper
   (`CRABBOX_COORDINATOR_TOKEN_COMMAND`, a JSON argv array), or an operator-run
   `crabbox login --url <approved-coordinator-url> --token-stdin` supplied directly
   by the secret store. If using a helper, configure the approved URL with
   `crabbox config set-broker --url <approved-coordinator-url>` and make the
   helper available to the service itself, not just in a shell profile. Stop
   here if no approved credential
   exists. Do not open, copy, or paste another machine's Crabbox config, a
   broker admin/shared token, an OAuth login link, or a ClawRouter key into the
   task. An hc credential or the per-run Pi key cannot authenticate Serve.
4. After login, start one donor in the foreground under the approved user. For
   example, on `agent-runner` (use the name and offer from the table elsewhere):

   ```sh
   crabbox serve --name agent-runner-hc-serve --runtime docker \
     --cpus 2 --memory 4g --no-lan-candidates
   ```

   The default tailnet SSH front door is TCP 2222. Restrict access to the
   approved clients; Serve can also relay through the coordinator. From the
   dispatch host use `crabbox serve machines --json` to confirm the unique
   machine UUID, owner-visible registration, native architecture, and caps.
   Wait for `available` before a test lease. Run one small pinned lease and
   confirm its reported machine UUID matches the registration and that the
   slot is freed after release. After the foreground test ends, `crabbox serve
   install` with the same flags is the persistent user-service equivalent
   (systemd user service or LaunchAgent); binary installation does not do this.
   See [Serve](https://github.com/valkyriweb/crabbox/blob/v0.79.1-valky.11/docs/providers/serve.md)
   and [login](https://github.com/valkyriweb/crabbox/blob/v0.79.1-valky.11/docs/commands/login.md)
   for broker requirements and graceful drain behavior.

### Herdr sync hook

The installer is standalone; no checkout or Node is needed on the target.
From a machine with the Herdr link (for this rollout, dry-run on
**`agent-runner` only**):

```sh
hc exec --on agent-runner -i -- bash -s -- --dry-run < agent-run/bin/install-crabbox-linux.sh
```

This prints the pin, digest, and paths without downloading or writing anything.
An opt-in `machines sync` step can use the same `hc exec` invocation without
`--dry-run` to install the binary. It is not added to Herdr's sync by this repo.
Keep `~/.local/bin` on the PATH used by non-interactive clients, or call the
installed binary explicitly.

## Target a lane

Run from a dispatch host that can already use Crabbox and, for `agent-run`, can
mint and revoke per-run ClawRouter keys as described in [credentials](credentials.md).
Set `MODEL` to an approved ClawRouter model before dispatch.

```sh
AGENT_RUN_LANE_MACHINE=agent-runner node agent-run/bin/agent-run.mjs \
  --harness pi --model "$MODEL" --prompt-file task.md --placement remote --out ./results/pi
```

The Herdr name pins the broker donor by name, sets its lease size and expected
architecture, and disables fallback to another provider. The receipt records
the Herdr name and requested broker name; use the lease's broker machine UUID
for proof of actual execution. Unset older `AGENT_RUN_CRABBOX_MACHINE` and
`AGENT_RUN_CRABBOX_TYPE` overrides if they conflict. This also pins any lease
needed by `agent-run appliance build`. `--placement remote` bypasses Harbor;
with `auto`, Harbor can still choose to run locally before the lease path.

The Mac mini is for lightweight Pi turns only. It defaults to `arm64` (Apple
Silicon) with a distinct Linux appliance; if the broker reports `amd64` for an
Intel Mac mini, set `AGENT_RUN_LANE_ARCH=amd64`. Do not send builds, install
jobs, or long or parallel turns there. A cold Pi appliance is assembled on the
dispatch host, not in a lease on the mini; an unreviewed dependency install
script fails the build before leasing. The single-slot limit is enforced on the
donor with `--max-leases 1`, not by counting processes on the client.

For a command lease, the wrapper calls the existing `heavy` from agent-scripts
(on the dispatch PATH) in remote-only mode, with the same pin, size and arch:

```sh
node agent-run/bin/lane-heavy.mjs lue-and-naddy-mbp-old -- pnpm test
node agent-run/bin/lane-heavy.mjs lue-and-naddy-server --light --no-sync -- uname -m
```

`--light` is required on the Mac mini. It is the dispatcher's promise that the
command is light; neither Crabbox nor the wrapper classifies arbitrary shell
commands. If the selected donor has no slot, heavy exits 75 and does not run
the command on the dispatch host. Keep the normal Crabbox client on the heavy
path; an operator-provided `HEAVY_CRABBOX` wrapper must preserve the Crabbox
machine, architecture, and fallback environment.
