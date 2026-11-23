// Herdr machine names are selectors, not SSH destinations. The separate
// broker names avoid colliding with the same hosts' kube donors.
const LANES = new Map([
  ["agent-runner", { donor: "agent-runner-hc-serve", type: "cpu2", arch: "amd64" }],
  ["asus-laptop-1", { donor: "asus-laptop-1-hc-serve", type: "cpu2", arch: "amd64" }],
  ["lue-and-naddy-mbp-old", { donor: "lue-and-naddy-mbp-old-hc-serve", type: "cpu4", arch: "amd64" }],
  ["lue-and-naddy-server", { donor: "lue-and-naddy-server-hc-serve", type: "cpu1", arch: "arm64", lightOnly: true }],
]);

export function serveLane(machine, arch) {
  if (machine === undefined && arch === undefined) return undefined;
  const profile = LANES.get(machine);
  if (!profile) throw new Error("select a known Herdr machine: " + [...LANES.keys()].join(", "));
  if (arch !== undefined && (!profile.lightOnly || !["amd64", "arm64"].includes(arch))) {
    throw new Error("AGENT_RUN_LANE_ARCH may be amd64 or arm64, and is only for the Mac mini");
  }
  return { machine, ...profile, arch: arch ?? profile.arch };
}

export function assertLaneHarness(lane, harness) {
  if (lane?.lightOnly && harness !== "pi") throw new Error("the Mac mini lane only accepts lightweight Pi turns");
}
