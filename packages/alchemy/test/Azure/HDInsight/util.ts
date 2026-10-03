import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:hdinsight", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Fixed test credential satisfying HDInsight's complexity rules. */
export const gatewayPassword = Redacted.make("Alchemy-Hdi-Test-Pass1!");

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 40,
    }),
  );

/** Resource group + storage account + container backing a cluster. */
export const clusterStorage = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.Storage.StorageAccount("Store", {
    resourceGroup: group.resourceGroupName,
  });
  const container = yield* Azure.Storage.BlobContainer("Root", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  return { group, account, container };
});

/** The storage account's first access key, read out of band. */
export const accountKey = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const keys = yield* storage.ListStorageAccountKeys({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
    });
    return Redacted.make(keys.keys?.[0]?.value ?? "");
  });

/** A minimal Hadoop cluster on the storage from `clusterStorage`. */
export const clusterProgram = (
  key: Redacted.Redacted<string>,
  props: Partial<Azure.HDInsight.ClusterProps> = {},
) =>
  Effect.gen(function* () {
    const { group, account, container } = yield* clusterStorage;
    const cluster = yield* Azure.HDInsight.Cluster("Hadoop", {
      resourceGroup: group.resourceGroupName,
      kind: "hadoop",
      gatewayPassword,
      storage: {
        type: "Blob",
        storageAccountName: account.storageAccountName,
        container: container.containerName,
        key,
        storageAccountId: account.storageAccountId,
      },
      ...props,
    });
    return { group, account, container, cluster };
  });
