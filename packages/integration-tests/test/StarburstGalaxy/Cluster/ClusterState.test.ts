import { clusterStateOf } from "@alchemy.run/starburst-galaxy/Cluster/Cluster";
import { expect, test } from "@alchemy.run/test";

// Galaxy's spellings (upper case on the wire), plus the variants a lenient
// reader must still recognize.
const known = {
  NotEnabled: ["DISABLED", "NOT_ENABLED"],
  Enabled: ["ENABLED"],
  Starting: ["STARTING"],
  Running: ["RUNNING"],
  Suspended: ["SUSPENDED"],
} as const;

const spellings = (wire: string) => [
  wire,
  wire.toLowerCase(),
  wire.replaceAll("_", "-"),
  wire.replaceAll("_", " ").toLowerCase(),
];

test(
  "every spelling of a known cluster state normalizes to its tag",
  () => {
    for (const [tag, wires] of Object.entries(known)) {
      for (const wire of wires) {
        for (const spelling of spellings(wire)) {
          expect(clusterStateOf(spelling)).toEqual({ _tag: tag });
        }
      }
    }
  },
  { tags: ["unit", "provider:starburst-galaxy", "local"] },
);

test(
  "an unknown or missing state is kept verbatim, never guessed into a known one",
  () => {
    for (const raw of ["STOPPED", "STOPPING", "FAILED", "RUNNING_DEGRADED", "SUSPEND", ""]) {
      expect(clusterStateOf(raw)).toEqual({ _tag: "Other", raw });
    }
    expect(clusterStateOf(undefined)).toEqual({ _tag: "Other", raw: "" });
  },
  { tags: ["unit", "provider:starburst-galaxy", "local"] },
);
