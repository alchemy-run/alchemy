import { ClusterState, clusterStateOf } from "@alchemy.run/starburst-galaxy/Cluster/Cluster";
import { expect, test } from "@alchemy.run/test";

test(
  "each state Galaxy sends maps to its tag",
  () => {
    expect(clusterStateOf("DISABLED")).toEqual(ClusterState.NotEnabled());
    expect(clusterStateOf("ENABLED")).toEqual(ClusterState.Enabled());
    expect(clusterStateOf("STARTING")).toEqual(ClusterState.Starting());
    expect(clusterStateOf("RUNNING")).toEqual(ClusterState.Running());
    expect(clusterStateOf("SUSPENDED")).toEqual(ClusterState.Suspended());
  },
  { tags: ["unit", "provider:starburst-galaxy", "local"] },
);

test(
  "an unknown or missing state is kept verbatim, never guessed into a known one",
  () => {
    for (const raw of ["STOPPED", "STOPPING", "FAILED", "running", "SUSPEND", ""]) {
      expect(clusterStateOf(raw)).toEqual(ClusterState.Other({ raw }));
    }
    expect(clusterStateOf(undefined)).toEqual(ClusterState.Other({ raw: "" }));
    expect(ClusterState.$is("Other")(clusterStateOf("STOPPED"))).toBe(true);
  },
  { tags: ["unit", "provider:starburst-galaxy", "local"] },
);
