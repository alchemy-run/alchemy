import * as GCP from "@alchemy.run/gcp";

/**
 * The smallest Cloud SQL instance, for suites that test what lives on one
 * (users, databases, backups, certificates). Creating it takes 5-10 minutes,
 * so those lifecycles are skipped under `--fast`.
 */
export const TestInstance = GCP.SQL.Instance("TestDb", {
  databaseVersion: "POSTGRES_17",
  edition: "ENTERPRISE",
  tier: "db-f1-micro",
  availabilityType: "ZONAL",
  backup: { enabled: false },
  deletionProtectionEnabled: false,
});
