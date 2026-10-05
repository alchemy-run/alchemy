import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getShare = (
  resourceGroupName: string,
  accountName: string,
  shareName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetFileShare({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareName,
    });
  });

const shareGone = (
  resourceGroupName: string,
  accountName: string,
  shareName: string,
) =>
  getShare(resourceGroupName, accountName, shareName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ShareNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (
  share?: Omit<
    Azure.Storage.FileShareProps,
    "resourceGroup" | "storageAccount"
  >,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const fileShare = share
      ? yield* Azure.Storage.FileShare("Share", {
          ...share,
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
        })
      : undefined;
    return { group, account, fileShare };
  });

// Standard_LRS account + 5-10 GiB empty share: ~$0, ~1 minute.
test.provider(
  "create, update, and delete a file share",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ shareQuota: 5, metadata: { purpose: "docs" } }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const share = created.fileShare!;
      expect(share.shareQuota).toEqual(5);
      expect(share.enabledProtocols).toEqual("SMB");
      expect(share.metadata).toEqual({ purpose: "docs" });
      const observed = yield* getShare(rg, acct, share.shareName);
      expect(observed.properties?.shareQuota).toEqual(5);
      expect(observed.properties?.metadata?.alchemy_id).toEqual("Share");

      // In-place update: quota, tier, metadata, and a stored access policy.
      const updated = yield* stack.deploy(
        program({
          shareQuota: 10,
          accessTier: "Cool",
          metadata: { purpose: "archive" },
          accessPolicies: [
            {
              id: "readers",
              permission: "rl",
              startTime: "2026-01-01T00:00:00Z",
              expiryTime: "2030-01-01T00:00:00Z",
            },
          ],
        }),
      );
      expect(updated.fileShare!.shareName).toEqual(share.shareName);
      const reobserved = yield* getShare(rg, acct, share.shareName);
      expect(reobserved.properties?.shareQuota).toEqual(10);
      expect(reobserved.properties?.accessTier).toEqual("Cool");
      expect(reobserved.properties?.metadata?.purpose).toEqual("archive");
      expect(
        reobserved.properties?.signedIdentifiers?.map((policy) => policy.id),
      ).toEqual(["readers"]);

      // Removing the share from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* shareGone(rg, acct, share.shareName)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
