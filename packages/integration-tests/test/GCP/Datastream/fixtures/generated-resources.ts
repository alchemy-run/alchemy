import * as GCP from "@alchemy.run/gcp";

/** A BigQuery destination profile for the generated Datastream bindings. */
export const ProbeProfile = GCP.Datastream.ConnectionProfile("ProbeProfile", {
  location: "us-central1",
  displayName: "probe-bq",
  bigqueryProfile: {},
});
