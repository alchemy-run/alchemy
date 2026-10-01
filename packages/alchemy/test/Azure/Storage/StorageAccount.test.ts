import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetStorageAccountProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
  });

const getContainer = (
  resourceGroupName: string,
  accountName: string,
  containerName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetBlobContainer({
      subscriptionId,
      resourceGroupName,
      accountName,
      containerName,
    });
  });

const accountGone = (resourceGroupName: string, accountName: string) =>
  getAccount(resourceGroupName, accountName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  sku: Azure.Storage.StorageSkuName;
  accessTier: Azure.Storage.StorageAccessTier;
  tags: Record<string, string>;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
      sku: props.sku,
      accessTier: props.accessTier,
      tags: props.tags,
    });
    const container = yield* Azure.Storage.BlobContainer("Uploads", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      metadata: props.metadata,
    });
    return { group, account, container };
  });

test.provider(
  "create, update, and delete a storage account with a blob container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          sku: "Standard_LRS",
          accessTier: "Hot",
          tags: { env: "test" },
          metadata: { purpose: "uploads" },
        }),
      );
      const { account, container, group } = created;
      expect(account.storageAccountName).toMatch(/^[a-z0-9]{3,24}$/);
      expect(account.sku).toEqual("Standard_LRS");
      expect(account.kind).toEqual("StorageV2");
      expect(account.primaryEndpoints.blob).toContain(
        `${account.storageAccountName}.blob.core.windows.net`,
      );
      expect(container.metadata).toEqual({ purpose: "uploads" });

      const observed = yield* getAccount(
        group.resourceGroupName,
        account.storageAccountName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.minimumTlsVersion).toEqual("TLS1_2");
      expect(observed.properties?.allowBlobPublicAccess).toEqual(false);
      expect(observed.properties?.supportsHttpsTrafficOnly).toEqual(true);
      expect(observed.properties?.accessTier).toEqual("Hot");
      expect(observed.tags?.env).toEqual("test");

      const observedContainer = yield* getContainer(
        group.resourceGroupName,
        account.storageAccountName,
        container.containerName,
      );
      expect(observedContainer.properties?.publicAccess).toEqual("None");
      expect(observedContainer.properties?.metadata?.purpose).toEqual(
        "uploads",
      );
      expect(observedContainer.properties?.metadata?.alchemy_id).toEqual(
        "Uploads",
      );

      // In-place updates: access tier, tags, and container metadata. SKU stays
      // fixed: a replication change starts a background geo conversion that
      // can block delete for longer than a test should wait.
      const updated = yield* stack.deploy(
        program({
          sku: "Standard_LRS",
          accessTier: "Cool",
          tags: { env: "prod" },
          metadata: { purpose: "archive" },
        }),
      );
      expect(updated.account.storageAccountName).toEqual(
        account.storageAccountName,
      );
      expect(updated.container.containerName).toEqual(container.containerName);
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.storageAccountName,
      );
      expect(reobserved.sku?.name).toEqual("Standard_LRS");
      expect(reobserved.properties?.accessTier).toEqual("Cool");
      expect(reobserved.tags?.env).toEqual("prod");
      const reobservedContainer = yield* getContainer(
        group.resourceGroupName,
        account.storageAccountName,
        container.containerName,
      );
      expect(reobservedContainer.properties?.metadata?.purpose).toEqual(
        "archive",
      );

      yield* stack.destroy();
      expect(
        yield* accountGone(group.resourceGroupName, account.storageAccountName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 420_000,
  },
);
