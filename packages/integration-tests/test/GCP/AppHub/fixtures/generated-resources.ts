import * as GCP from "@alchemy.run/gcp";

/** AppHub resources the generated bindings bind, mirroring each resource suite's smallest shape. */
export const ProbeApplication = GCP.AppHub.Application("ProbeApplication", {
  location: "us-central1",
  displayName: "probe",
  scope: { type: "REGIONAL" },
});
