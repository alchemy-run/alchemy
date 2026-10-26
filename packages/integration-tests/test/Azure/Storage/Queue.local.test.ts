import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as queue from "@distilled.cloud/azure/storage-queue";
import * as Alchemy from "alchemy";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { onAzurite } from "../azurite.ts";

// `dev: true`: StorageAccount and Queue resolve their local providers
// (Azurite in Docker), like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const program = (metadata: Record<string, string>) =>
  Effect.gen(function* () {
    const account = yield* Azure.Storage.StorageAccount("DevQueueAccount");
    const jobs = yield* Azure.Storage.Queue("DevQueue", {
      storageAccount: account.storageAccountName,
      metadata,
    });
    return { account, jobs };
  });

const localQueue = (queueName: string) =>
  onAzurite(({ queue: url }) =>
    queue.GetQueueProperties({ url, queueName }).pipe(
      Effect.map((props) => ({ status: "found" as const, metadata: props.metadata ?? {} })),
      Effect.catchTag("QueueNotFound", () =>
        Effect.succeed({ status: "gone" as const, metadata: {} as queue.HeaderCollection }),
      ),
    ),
  );

test.provider(
  "a local queue lives in Azurite: create, update metadata, send, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ purpose: "jobs" }));
      expect(created.account.storageAccountName).toBe("devstoreaccount1");
      expect(created.jobs.queueId).toMatch(/^dev:/);
      const name = created.jobs.queueName;

      // Out of band: the queue is in Azurite with the ownership markers.
      const observed = yield* localQueue(name);
      expect(observed.status).toBe("found");
      expect(observed.metadata.purpose).toBe("jobs");
      expect(observed.metadata.alchemy_id).toBe("DevQueue");

      const updated = yield* stack.deploy(program({ purpose: "batch" }));
      expect(updated.jobs.queueName).toBe(name);
      expect((yield* localQueue(name)).metadata.purpose).toBe("batch");

      // The emulated queue takes and returns messages.
      yield* onAzurite(({ queue: url }) =>
        queue.MessagesEnqueue({ url, queueName: name, MessageText: "hello" }),
      );
      const peeked = yield* onAzurite(({ queue: url }) =>
        queue.MessagesPeek({ url, queueName: name, numofmessages: 1 }),
      );
      expect(peeked.map((m) => m.MessageText)).toEqual(["hello"]);

      yield* stack.destroy();
      expect((yield* localQueue(name)).status).toBe("gone");
    }),
  { timeout: 180_000 },
);

const remoteQueue = (resourceGroupName: string, accountName: string, queueName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage
      .GetQueue({ subscriptionId, resourceGroupName, accountName, queueName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["QueueNotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
      );
  });

// ~$0.01; ~1 min (one Standard_LRS account).
test.provider(
  "Alchemy.remote() creates the account and queue in Azure during dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program({ purpose: "remote" }).pipe(Alchemy.remote()));
      expect(deployed.account.storageAccountName).not.toBe("devstoreaccount1");
      expect(deployed.jobs.queueId).toMatch(/^\/subscriptions\//);
      const where = [
        deployed.jobs.resourceGroup,
        deployed.account.storageAccountName,
        deployed.jobs.queueName,
      ] as const;
      expect(yield* remoteQueue(...where)).toBe("found");

      yield* stack.destroy();
      const after = yield* remoteQueue(...where).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (status) => status === "gone",
          times: 20,
        }),
      );
      expect(after).toBe("gone");
    }),
  { timeout: 300_000 },
);
