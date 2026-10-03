import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as vi from "@distilled.cloud/azure/vi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* vi.GetAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
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
      times: 24,
    }),
  );

const program = (props: {
  tags: Record<string, string>;
  publicNetworkAccess?: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const storage = yield* Azure.Storage.StorageAccount("Media", {
      resourceGroup: group.resourceGroupName,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "IndexerIdentity",
      { resourceGroup: group.resourceGroupName },
    );
    const grant = yield* Azure.Authorization.RoleAssignment("IndexerStorage", {
      scope: storage.storageAccountId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
      principalId: identity.principalId,
      principalType: "ServicePrincipal",
    });
    const account = yield* Azure.VideoIndexer.Account("Indexer", {
      resourceGroup: group.resourceGroupName,
      storageAccountId: storage.storageAccountId,
      storageUserAssignedIdentity: identity.identityId,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: { ...props.tags, grant: grant.principalId },
    });
    return { group, storage, identity, account };
  });

// Account creation is free (indexing is billed per minute; none here);
// the storage account is an empty Standard_LRS. A few minutes, < $0.01.
test.provider(
  "create, update, and delete a video indexer account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const name = created.account.accountName;
      expect(created.account.accountId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(created.account.storageAccountId.toLowerCase()).toEqual(
        created.storage.storageAccountId.toLowerCase(),
      );
      const observed = yield* getAccount(rg, name);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Indexer");
      expect(
        observed.properties?.storageServices?.userAssignedIdentity?.toLowerCase(),
      ).toEqual(created.identity.identityId.toLowerCase());
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // In-place update: tags and public network access.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod" }, publicNetworkAccess: "Disabled" }),
      );
      expect(updated.account.accountName).toEqual(name);
      expect(updated.account.accountId).toEqual(created.account.accountId);
      expect(updated.account.tags.env).toEqual("prod");
      expect(updated.account.publicNetworkAccess).toEqual("Disabled");
      const reobserved = yield* getAccount(rg, name);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* accountGone(rg, name)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:videoindexer", "live"],
    timeout: 900_000,
  },
);
