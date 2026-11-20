import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** The cheapest Cloud SQL instance, with a database and user, for the generated SQL bindings. */
export const ProbeInstance = GCP.SQL.Instance("ProbeDb", {
  databaseVersion: "POSTGRES_17",
  edition: "ENTERPRISE",
  tier: "db-f1-micro",
  availabilityType: "ZONAL",
  backup: { enabled: false },
  deletionProtectionEnabled: false,
});
export const ProbeDatabase = Effect.gen(function* () {
  const instance = yield* ProbeInstance;
  return yield* GCP.SQL.Database("ProbeApp", { instance: instance.instanceName });
});
export const ProbeUser = Effect.gen(function* () {
  const instance = yield* ProbeInstance;
  return yield* GCP.SQL.User("ProbeUser", {
    instance: instance.instanceName,
    password: "Alchemy-probe-user-1",
  });
});
