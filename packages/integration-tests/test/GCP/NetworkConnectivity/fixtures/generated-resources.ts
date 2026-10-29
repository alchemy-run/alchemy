import * as GCP from "@alchemy.run/gcp";

/** NetworkConnectivity resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeHub = GCP.NetworkConnectivity.Hub("ProbeHub", {
  description: "ncc hub a",
});
export const ProbeMulticloudDataTransferConfig =
  GCP.NetworkConnectivity.MulticloudDataTransferConfig("ProbeMulticloudDataTransferConfig", {
    location: "europe-west1",
    description: "dte a",
    services: { "cloud-storage": {}, "compute-engine": {} },
  });
