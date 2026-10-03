import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  watcherName: string,
  sharedPrivateLinkResourceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* databasewatcher.GetSharedPrivateLinkResource({
      subscriptionId,
      resourceGroupName,
      watcherName,
      sharedPrivateLinkResourceName,
    });
  });

const linkGone = (
  resourceGroupName: string,
  watcherName: string,
  sharedPrivateLinkResourceName: string,
) =>
  getLink(resourceGroupName, watcherName, sharedPrivateLinkResourceName).pipe(
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

// A pending managed private endpoint to a Standard Key Vault: the vault and
// the unapproved endpoint cost cents (<$0.05), but the run takes ~15 minutes
// (watcher create ~3-4 min and delete ~4-5 min, each link create ~2 min and
// delete ~1 min), past the ~10 minute budget.
const program = (link?: { requestMessage: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
    });
    const watcher = yield* Azure.DatabaseWatcher.Watcher("Watcher", {
      resourceGroup: group.resourceGroupName,
    });
    const l = link
      ? yield* Azure.DatabaseWatcher.SharedPrivateLinkResource("VaultLink", {
          resourceGroup: group.resourceGroupName,
          watcher: watcher.watcherName,
          privateLinkResourceId: vault.vaultId,
          groupId: "vault",
          requestMessage: link.requestMessage,
        })
      : undefined;
    return { group, vault, watcher, link: l };
  });

test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a database watcher shared private link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ requestMessage: "watcher access" }),
      );
      const rg = created.group.resourceGroupName;
      const watcherName = created.watcher.watcherName;
      const first = created.link!;
      expect(first.groupId).toEqual("vault");
      expect(first.provisioningState).toEqual("Succeeded");
      const observed = yield* getLink(
        rg,
        watcherName,
        first.sharedPrivateLinkResourceName,
      );
      expect(observed.properties?.privateLinkResourceId.toLowerCase()).toEqual(
        created.vault.vaultId.toLowerCase(),
      );
      expect(observed.properties?.requestMessage).toEqual("watcher access");

      // Every property is immutable: a new request message replaces the link.
      const replaced = yield* stack.deploy(
        program({ requestMessage: "watcher access v2" }),
      );
      const second = replaced.link!;
      expect(second.sharedPrivateLinkResourceName).not.toEqual(
        first.sharedPrivateLinkResourceName,
      );
      const reobserved = yield* getLink(
        rg,
        watcherName,
        second.sharedPrivateLinkResourceName,
      );
      expect(reobserved.properties?.requestMessage).toEqual(
        "watcher access v2",
      );
      expect(
        yield* linkGone(rg, watcherName, first.sharedPrivateLinkResourceName),
      ).toEqual("gone");

      // Removing the link from the stack deletes it.
      yield* stack.deploy(program());
      expect(
        yield* linkGone(rg, watcherName, second.sharedPrivateLinkResourceName),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:databasewatcher", "live"],
    timeout: 900_000,
  },
);
