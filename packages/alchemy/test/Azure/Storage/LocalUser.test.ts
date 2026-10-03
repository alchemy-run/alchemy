import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

// Checked-in fixture key (the private half was discarded).
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGn49/NxZFYVjgszM5ZirsZR7SgvrXA2hfBFcxJmgJPM alchemy-test";

const getUser = (
  resourceGroupName: string,
  accountName: string,
  username: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetLocalUser({
      subscriptionId,
      resourceGroupName,
      accountName,
      username,
    });
  });

const listKeys = (
  resourceGroupName: string,
  accountName: string,
  username: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.ListLocalUserKeys({
      subscriptionId,
      resourceGroupName,
      accountName,
      username,
    });
  });

const userGone = (
  resourceGroupName: string,
  accountName: string,
  username: string,
) =>
  orUndefinedIfNotFound(getUser(resourceGroupName, accountName, username)).pipe(
    Effect.map((user) => (user === undefined ? "gone" : "found")),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

type UserSettings = Omit<
  Azure.Storage.LocalUserProps,
  "resourceGroup" | "storageAccount"
>;

const program = (user?: UserSettings) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const container = yield* Azure.Storage.BlobContainer("Uploads", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    const local = user
      ? yield* Azure.Storage.LocalUser("Partner", {
          ...user,
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
        })
      : undefined;
    return { group, account, container, local };
  });

// Standard_LRS account without SFTP enabled (no SFTP hourly charge):
// ~$0, ~1 minute.
test.provider(
  "create, update, and delete a local user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          homeDirectory: "uploads",
          sshAuthorizedKeys: [{ key: PUBLIC_KEY, description: "ci" }],
        }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const username = created.local!.localUserName;
      expect(username).toMatch(/^[a-z0-9]{3,64}$/);
      expect(created.local!.hasSshKey).toEqual(true);
      expect(created.local!.sid).toBeDefined();
      const observed = yield* getUser(rg, acct, username);
      expect(observed.properties?.homeDirectory).toEqual("uploads");
      expect(observed.properties?.hasSshKey).toEqual(true);
      const keys = yield* listKeys(rg, acct, username);
      // Azure keeps the key type and material, dropping the comment.
      expect(keys.sshAuthorizedKeys?.map((k) => k.key)).toEqual([
        PUBLIC_KEY.split(" ").slice(0, 2).join(" "),
      ]);

      // In-place update: grant read/write/list on the container and switch
      // from SSH keys to shared-key access.
      const updated = yield* stack.deploy(
        program({
          homeDirectory: "uploads",
          permissionScopes: [
            {
              service: "blob",
              resourceName: created.container.containerName,
              permissions: "rwl",
            },
          ],
          hasSharedKey: true,
        }),
      );
      expect(updated.local!.localUserName).toEqual(username);
      expect(updated.local!.permissionScopes).toHaveLength(1);
      const reobserved = yield* getUser(rg, acct, username);
      expect(reobserved.properties?.hasSharedKey).toEqual(true);
      expect(reobserved.properties?.hasSshKey).toEqual(false);
      expect(
        reobserved.properties?.permissionScopes?.[0]?.resourceName,
      ).toEqual(created.container.containerName);
      expect(
        [...(reobserved.properties?.permissionScopes?.[0]?.permissions ?? "")]
          .sort()
          .join(""),
      ).toEqual("lrw");
      const rekeys = yield* listKeys(rg, acct, username);
      expect(rekeys.sshAuthorizedKeys ?? []).toEqual([]);

      // Removing the resource deletes the user.
      yield* stack.deploy(program());
      expect(yield* userGone(rg, acct, username)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
