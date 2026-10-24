import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { ensureFeature } from "../features.ts";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDataShare = (rg: string, account: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetDataShare({
      subscriptionId,
      resourceGroupName: rg,
      accountName: account,
      dataShareName: name,
    });
  });

const dataShareGone = (rg: string, account: string, name: string) =>
  getDataShare(rg, account, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.Storage.StorageAccount("Account", {
    resourceGroup: group.resourceGroupName,
    dataCollaborationPolicy: { allowStorageDataShares: true },
  });
  const container = yield* Azure.Storage.BlobContainer("Shared", {
    resourceGroup: group.resourceGroupName,
    storageAccount: account.storageAccountName,
  });
  const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Reader", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, account, container, identity };
});

// Standard_LRS account + container + identity: ~$0, ~1 minute.
test.provider(
  "probe: storage data shares are not routed without preview enrollment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, account } = yield* stack.deploy(base);
      expect(account.dataCollaborationPolicy.allowStorageDataShares).toEqual(true);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* storage
        .CreateDataShare({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.storageAccountName,
          dataShareName: "alchemy-probe",
          location: "eastus",
          properties: { accessPolicies: [], assets: [] },
        })
        .pipe(Effect.flip);
      // ARM does not route the preview endpoint for this subscription: a
      // bare 404 "The request url .../dataShares/alchemy-probe?... is not
      // found." with no ARM error code, so only the status tag is available.
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("/dataShares/alchemy-probe");
      expect(error.message).toContain("is not found");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);

const program = (share?: { description: string; displayName: string; grantReader: boolean }) =>
  Effect.gen(function* () {
    const resources = yield* base;
    const shared = share
      ? yield* Azure.Storage.DataShare("Partner", {
          resourceGroup: resources.group.resourceGroupName,
          storageAccount: resources.account.storageAccountName,
          description: share.description,
          assets: [
            {
              assetPath: `/${resources.container.containerName}/external`,
              displayName: share.displayName,
            },
          ],
          accessPolicies: share.grantReader
            ? [
                {
                  principalId: resources.identity.principalId,
                  tenantId: resources.identity.tenantId,
                  permission: "Read",
                },
              ]
            : [],
        })
      : undefined;
    return { ...resources, shared };
  });

// Storage data shares are an approval-gated preview (feature
// Microsoft.Storage/StorageDataShare stays Pending until Microsoft approves
// the enrollment); until then ARM does not route `.../dataShares`.
// Data shares bill per data-plane use.
// ~$0/run, 2 min
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a storage data share",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureFeature("Microsoft.Storage", "StorageDataShare");
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ description: "first", displayName: "logs", grantReader: false }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const name = created.shared!.dataShareName;
      expect(name).toMatch(/^[a-z0-9-]{3,63}$/);
      expect(created.shared!.dataShareUri).toMatch(/^azds:\/\/eastus:/);
      const observed = yield* getDataShare(rg, acct, name);
      expect(observed.properties.description).toEqual("first");
      expect(observed.properties.accessPolicies).toEqual([]);
      expect(observed.properties.assets.map((a) => a.displayName)).toEqual(["logs"]);

      // In-place update: description, asset display name, and a reader grant.
      yield* stack.deploy(
        program({ description: "second", displayName: "external-logs", grantReader: true }),
      );
      const reobserved = yield* getDataShare(rg, acct, name);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.properties.assets.map((a) => a.displayName)).toEqual(["external-logs"]);
      expect(reobserved.properties.accessPolicies.map((p) => p.permission)).toEqual(["Read"]);
      expect(reobserved.properties.dataShareIdentifier).toEqual(
        observed.properties.dataShareIdentifier,
      );

      yield* stack.deploy(program());
      expect(yield* dataShareGone(rg, acct, name)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 1_800_000,
  },
);
