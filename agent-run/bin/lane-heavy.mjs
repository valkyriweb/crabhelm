#!/usr/bin/env node
import { serveLane } from "../lib/serve-lanes.mjs";

const usage = "usage: lane-heavy <Herdr machine> [--light] [--no-sync] (-c 'shell string' | -- command [args...])";
const [machine, ...args] = process.argv.slice(2);
if (machine === "--help" || machine === "-h") {
  console.log(usage);
  process.exit(0);
}

try {
  if (!machine) throw new Error(usage);
  const lane = serveLane(machine, process.env.AGENT_RUN_LANE_ARCH);
  const flags = new Set();
  while (["--light", "--no-sync"].includes(args[0])) flags.add(args.shift());
  if (!(args[0] === "--" && args[1]) && !(args[0] === "-c" && args.length === 2 && args[1])) {
    throw new Error(usage);
  }
  if (lane.lightOnly && !flags.has("--light")) throw new Error("the Mac mini lane requires --light; do not send builds, tests or installs there");
  // The agent-scripts heavy wrapper owns sync, timeouts and exit status. Use
  // its remote-only mode and never let a broker fallback replace the pin.
  const heavy = ["heavy", "--remote", "--type", lane.type, ...(flags.has("--no-sync") ? ["--no-sync"] : []), ...args];
  process.execve("/usr/bin/env", ["env", ...heavy], {
    ...process.env,
    CRABBOX_SERVE_MACHINE: lane.donor,
    CRABBOX_SERVE_FALLBACK: "serve", // Crabbox treats its current provider as no fallback.
    CRABBOX_ARCH: lane.arch,
  });
} catch (error) {
  console.error("lane-heavy: " + (error?.message ?? error));
  process.exitCode = 2;
}
