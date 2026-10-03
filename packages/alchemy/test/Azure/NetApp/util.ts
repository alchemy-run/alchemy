import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:netapp", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/** Region used by NetApp tests (needs an ANF-enabled, non-trial subscription). */
export const LOCATION = "eastus";

/** Resource group + NetApp account, the base of every NetApp test stack. */
export const accountBase = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: LOCATION,
  });
  const account = yield* Azure.NetApp.Account("Files", {
    resourceGroup: group.resourceGroupName,
    location: LOCATION,
  });
  return { group, account };
});

/**
 * Resource group, delegated subnet, account, 1 TiB Standard pool, and a
 * 100 GiB NFSv3 volume (pool ≈ $0.20/hour; volume create 3-6 minutes).
 */
export const volumeBase = Effect.gen(function* () {
  const { group, account } = yield* accountBase;
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location: LOCATION,
    addressPrefixes: ["10.20.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("AnfSubnet", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.20.1.0/24",
    delegations: [{ serviceName: "Microsoft.NetApp/volumes" }],
  });
  const pool = yield* Azure.NetApp.CapacityPool("Pool", {
    resourceGroup: group.resourceGroupName,
    account: account.accountName,
  });
  const volume = yield* Azure.NetApp.Volume("Data", {
    resourceGroup: group.resourceGroupName,
    account: account.accountName,
    pool: pool.poolName,
    subnetId: subnet.subnetId,
  });
  return { group, account, vnet, subnet, pool, volume };
});
