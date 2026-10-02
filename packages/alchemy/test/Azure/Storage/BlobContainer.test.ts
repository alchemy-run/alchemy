import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

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

const containerGone = (
  resourceGroupName: string,
  accountName: string,
  containerName: string,
) =>
  getContainer(resourceGroupName, accountName, containerName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ContainerNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (container?: {
  name?: string;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const blob = container
      ? yield* Azure.Storage.BlobContainer("Container", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          name: container.name,
          metadata: container.metadata,
        })
      : undefined;
    return { group, account, blob };
  });

test.provider(
  "create, update, replace, and delete a blob container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ metadata: { purpose: "uploads" } }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const first = created.blob!;
      expect(first.containerName).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      expect(first.metadata).toEqual({ purpose: "uploads" });
      const observed = yield* getContainer(rg, acct, first.containerName);
      expect(observed.properties?.publicAccess).toEqual("None");
      expect(observed.properties?.metadata?.purpose).toEqual("uploads");
      expect(observed.properties?.metadata?.alchemy_id).toEqual("Container");

      // In-place metadata update.
      const updated = yield* stack.deploy(
        program({ metadata: { purpose: "archive", owner: "ops" } }),
      );
      expect(updated.blob!.containerName).toEqual(first.containerName);
      const reobserved = yield* getContainer(rg, acct, first.containerName);
      expect(reobserved.properties?.metadata?.purpose).toEqual("archive");
      expect(reobserved.properties?.metadata?.owner).toEqual("ops");

      // Renaming replaces the container.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-renamed-container", metadata: {} }),
      );
      expect(renamed.blob!.containerName).toEqual("alchemy-renamed-container");
      const replacement = yield* getContainer(
        rg,
        acct,
        "alchemy-renamed-container",
      );
      expect(replacement.properties?.metadata?.alchemy_id).toEqual("Container");
      expect(yield* containerGone(rg, acct, first.containerName)).toEqual(
        "gone",
      );

      // Removing the container from the stack deletes it.
      yield* stack.deploy(program());
      expect(
        yield* containerGone(rg, acct, "alchemy-renamed-container"),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
