import * as GCP from "@alchemy.run/gcp";

/** DataMigration resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeConnectionProfile = GCP.DataMigration.ConnectionProfile(
  "ProbeConnectionProfile",
  {
    location: "us-central1",
    displayName: "mysql-src",
    mysql: {
      host: "10.0.0.8",
      port: 3306,
      username: "alchemy",
      password: "AlchemyTestPass1",
    },
  },
);
export const ProbeConversionWorkspace = GCP.DataMigration.ConversionWorkspace(
  "ProbeConversionWorkspace",
  {
    location: "us-central1",
    displayName: "oracle-to-pg",
    source: { engine: "ORACLE", version: "11" },
    destination: { engine: "POSTGRESQL", version: "14" },
    globalSettings: { skip_triggers: "false" },
  },
);
