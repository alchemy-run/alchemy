import * as GCP from "@alchemy.run/gcp";

/** CES resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeApp = GCP.CES.App("ProbeApp", {
  location: "us",
  displayName: "support",
  description: "help desk",
  timeZone: "America/Los_Angeles",
});
