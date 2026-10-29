import * as GCP from "@alchemy.run/gcp";

/** MigrationCenter resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeAssetsExportJob = GCP.MigrationCenter.AssetsExportJob("ProbeAssetsExportJob", {
  location: "us-central1",
  fileFormat: "CSV",
});
export const ProbeGroup = GCP.MigrationCenter.Group("ProbeGroup", {
  location: "us-central1",
  displayName: "workloads",
  description: "production vms",
});
export const ProbePreferenceSet = GCP.MigrationCenter.PreferenceSet("ProbePreferenceSet", {
  location: "us-central1",
  displayName: "prod-gce",
  description: "gce defaults",
});
export const ProbeSource = GCP.MigrationCenter.Source("ProbeSource", {
  location: "us-central1",
  type: "SOURCE_TYPE_CUSTOM",
  displayName: "custom assets",
  description: "inventory feed",
  priority: 1,
});
