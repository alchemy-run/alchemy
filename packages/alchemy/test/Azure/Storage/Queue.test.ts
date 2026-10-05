import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getQueue = (
  resourceGroupName: string,
  accountName: string,
  queueName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetQueue({
      subscriptionId,
      resourceGroupName,
      accountName,
      queueName,
    });
  });

const queueGone = (
  resourceGroupName: string,
  accountName: string,
  queueName: string,
) =>
  getQueue(resourceGroupName, accountName, queueName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("QueueNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (queue?: { name?: string; metadata: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const jobs = queue
      ? yield* Azure.Storage.Queue("Jobs", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          name: queue.name,
          metadata: queue.metadata,
        })
      : undefined;
    return { group, account, jobs };
  });

test.provider(
  "create, update, replace, and delete a storage queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ metadata: { purpose: "jobs" } }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const first = created.jobs!;
      expect(first.queueName).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      expect(first.metadata).toEqual({ purpose: "jobs" });
      const observed = yield* getQueue(rg, acct, first.queueName);
      expect(observed.properties?.metadata?.purpose).toEqual("jobs");
      expect(observed.properties?.metadata?.alchemy_id).toEqual("Jobs");

      // In-place metadata update.
      const updated = yield* stack.deploy(
        program({ metadata: { purpose: "retries" } }),
      );
      expect(updated.jobs!.queueName).toEqual(first.queueName);
      const reobserved = yield* getQueue(rg, acct, first.queueName);
      expect(reobserved.properties?.metadata?.purpose).toEqual("retries");

      // Renaming replaces the queue.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-renamed-queue", metadata: {} }),
      );
      expect(renamed.jobs!.queueName).toEqual("alchemy-renamed-queue");
      const replacement = yield* getQueue(rg, acct, "alchemy-renamed-queue");
      expect(replacement.properties?.metadata?.alchemy_id).toEqual("Jobs");
      expect(yield* queueGone(rg, acct, first.queueName)).toEqual("gone");

      // Removing the queue from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* queueGone(rg, acct, "alchemy-renamed-queue")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
