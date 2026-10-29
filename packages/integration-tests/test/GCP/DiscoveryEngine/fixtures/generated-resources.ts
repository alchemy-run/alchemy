import * as GCP from "@alchemy.run/gcp";

/** DiscoveryEngine resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeCollectionsDataStore = GCP.DiscoveryEngine.CollectionsDataStore(
  "ProbeCollectionsDataStore",
  {
    location: "global",
    displayName: "docs",
    industryVertical: "GENERIC",
    contentConfig: "NO_CONTENT",
    solutionTypes: ["SOLUTION_TYPE_SEARCH"],
    disableCmek: true,
  },
);
export const ProbeDataStore = GCP.DiscoveryEngine.DataStore("ProbeDataStore", {
  location: "global",
  displayName: "docs",
  industryVertical: "GENERIC",
  contentConfig: "NO_CONTENT",
  solutionTypes: ["SOLUTION_TYPE_SEARCH"],
  disableCmek: true,
});
