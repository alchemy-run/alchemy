import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * Region of every resource in the example. One `Standard_D2s_v7` node
 * (2 vCPUs) fits the default regional vCPU quota.
 */
export const LOCATION = "westus2";

/**
 * The AKS cluster: one system node on the Free control-plane tier. The OIDC
 * issuer and Microsoft Entra Workload ID let a Kubernetes ServiceAccount
 * act as an Azure managed identity, which is how the API's blob binding
 * authenticates without keys.
 */
export const Cluster = Azure.ContainerService.ManagedCluster("Cluster", {
  location: LOCATION,
  defaultNodePool: { vmSize: "Standard_D2s_v7", count: 1 },
  oidcIssuerEnabled: true,
  workloadIdentityEnabled: true,
});

export const Data = Azure.Storage.StorageAccount("Data", { location: LOCATION });

/** Where the API stores notes, one blob per key. */
export const Notes = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Notes", {
    storageAccount: account.storageAccountName,
  });
});
