import * as GCP from "@alchemy.run/gcp";

/** VMMigration resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeGroup = GCP.VMMigration.Group("ProbeGroup", {
  location: "us-central1",
  displayName: "workloads",
  description: "production vms",
});
