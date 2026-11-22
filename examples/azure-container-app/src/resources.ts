import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * Region of every resource in the example. Container Apps environments
 * provision reliably in `westus2`.
 */
export const LOCATION = "westus2";

/**
 * The Container Apps environment. A Consumption workload profile has no
 * reserved cores and is free while no app runs; a runtime app needs it
 * (not `Express`) for its system-assigned managed identity.
 */
export const Environment = Azure.ContainerApps.ManagedEnvironment("Environment", {
  location: LOCATION,
  workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
});

export const Data = Azure.Storage.StorageAccount("Data", { location: LOCATION });

/** Where the API stores notes, one blob per key. */
export const Notes = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Notes", {
    storageAccount: account.storageAccountName,
  });
});
