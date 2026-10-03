import * as Azure from "@/Azure";
import { Credentials, type AzureOpError } from "@distilled.cloud/azure";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:datashare", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(
  get: Effect.Effect<A, AzureOpError, R>,
  times = 24,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );


/** Object ID of the deploying identity (the `oid` claim of the ARM token). */
export const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ).oid as string,
  );
});

export interface ChainOptions {
  /** Source container logical ID (changing it replaces the data set). */
  sourceContainer?: string;
  /** Invitation logical ID the subscription accepts (changing it replaces the subscription). */
  invitation?: "Invitation" | "Invitation2";
  /** Deploy the consumer half (account B, share subscription). */
  consumer?: boolean;
  /** Deploy the data set mapping (requires `consumer`). */
  mapping?: boolean;
  /** Target container logical ID (changing it replaces the mapping). */
  targetContainer?: string;
  /** Deploy the trigger with this mode (requires `consumer`). */
  trigger?: "Incremental" | "FullSync";
}

/**
 * Provider side (storage → account → share → data set → schedule →
 * invitation to the deploying identity) and optional consumer side
 * (account → share subscription → mapping → trigger), all free objects.
 */
export const chain = (options: ChainOptions) =>
  Effect.gen(function* () {
    const { subscriptionId, tenantId } = yield* Azure.AzureEnvironment.current;
    const objectId = yield* callerObjectId;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const storage = yield* Azure.Storage.StorageAccount("Storage", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const sources = {
      Source: yield* Azure.Storage.BlobContainer("Source", {
        resourceGroup: group.resourceGroupName,
        storageAccount: storage.storageAccountName,
      }),
      Source2:
        options.sourceContainer === "Source2"
          ? yield* Azure.Storage.BlobContainer("Source2", {
              resourceGroup: group.resourceGroupName,
              storageAccount: storage.storageAccountName,
            })
          : undefined,
    };
    const source = sources[(options.sourceContainer ?? "Source") as "Source"]!;
    const account = yield* Azure.DataShare.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    yield* Azure.Authorization.RoleAssignment("AccountReadsSource", {
      scope: storage.storageAccountId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
      principalId: account.principalId,
      principalType: "ServicePrincipal",
    });
    const share = yield* Azure.DataShare.Share("Share", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      description: "alchemy data share test",
    });
    const dataSet = yield* Azure.DataShare.DataSet("DataSet", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      share: share.shareName,
      kind: "Container",
      source: {
        subscriptionId,
        resourceGroup: group.resourceGroupName,
        storageAccountName: storage.storageAccountName,
        containerName: source.containerName,
      },
    });
    const setting = yield* Azure.DataShare.SynchronizationSetting("Daily", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      share: share.shareName,
      recurrenceInterval: "Day",
      synchronizationTime: "2026-01-01T06:00:00Z",
    });
    const invitation = yield* Azure.DataShare.Invitation("Invitation", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      share: share.shareName,
      targetActiveDirectoryId: tenantId,
      targetObjectId: objectId,
    });
    const invitation2 =
      options.invitation === "Invitation2"
        ? yield* Azure.DataShare.Invitation("Invitation2", {
            resourceGroup: group.resourceGroupName,
            account: account.accountName,
            share: share.shareName,
            targetActiveDirectoryId: tenantId,
            targetObjectId: objectId,
          })
        : undefined;
    if (!options.consumer) {
      return {
        group,
        storage,
        source,
        account,
        share,
        dataSet,
        setting,
        invitation,
      };
    }

    const consumer = yield* Azure.DataShare.Account("ConsumerAccount", {
      resourceGroup: group.resourceGroupName,
    });
    const subscription = yield* Azure.DataShare.ShareSubscription(
      "Subscription",
      {
        resourceGroup: group.resourceGroupName,
        account: consumer.accountName,
        invitationId: (invitation2 ?? invitation).invitationId,
        sourceShareLocation: account.location,
      },
    );
    let mapping: Azure.DataShare.DataSetMapping["Attributes"] | undefined;
    if (options.mapping) {
      yield* Azure.Authorization.RoleAssignment("ConsumerWritesTarget", {
        scope: storage.storageAccountId,
        roleDefinitionId:
          Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
        principalId: consumer.principalId,
        principalType: "ServicePrincipal",
      });
      const targets = {
        Target: yield* Azure.Storage.BlobContainer("Target", {
          resourceGroup: group.resourceGroupName,
          storageAccount: storage.storageAccountName,
        }),
        Target2:
          options.targetContainer === "Target2"
            ? yield* Azure.Storage.BlobContainer("Target2", {
                resourceGroup: group.resourceGroupName,
                storageAccount: storage.storageAccountName,
              })
            : undefined,
      };
      const target = targets[(options.targetContainer ?? "Target") as "Target"]!;
      mapping = yield* Azure.DataShare.DataSetMapping("Mapping", {
        resourceGroup: group.resourceGroupName,
        account: consumer.accountName,
        shareSubscription: subscription.shareSubscriptionName,
        kind: "Container",
        dataSetId: dataSet.dataSetId,
        target: {
          subscriptionId,
          resourceGroup: group.resourceGroupName,
          storageAccountName: storage.storageAccountName,
          containerName: target.containerName,
        },
      });
    }
    const trigger = options.trigger
      ? yield* Azure.DataShare.Trigger("Trigger", {
          resourceGroup: group.resourceGroupName,
          account: consumer.accountName,
          shareSubscription: subscription.shareSubscriptionName,
          recurrenceInterval: "Day",
          synchronizationTime: "2026-01-01T06:00:00Z",
          synchronizationMode: options.trigger,
        })
      : undefined;
    return {
      group,
      storage,
      source,
      account,
      share,
      dataSet,
      setting,
      invitation,
      consumer,
      subscription,
      mapping,
      trigger,
    };
  });
