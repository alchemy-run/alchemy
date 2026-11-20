import * as GCP from "@alchemy.run/gcp";

/** A composite index the generated Datastore index bindings read. */
export const ProbeIndex = GCP.Datastore.Index("ProbeIndex", {
  ancestor: "NONE",
  properties: [
    { name: "probeDone", direction: "ASCENDING" },
    { name: "probePriority", direction: "DESCENDING" },
  ],
});
