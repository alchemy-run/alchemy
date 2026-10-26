import * as Azure from "@alchemy.run/azure";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Alchemy from "alchemy";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { onAzurite } from "../azurite.ts";

// `dev: true`: StorageAccount and BlobContainer resolve their local
// providers (Azurite in Docker), like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const program = (metadata: Record<string, string>) =>
  Effect.gen(function* () {
    const account = yield* Azure.Storage.StorageAccount("DevAccount");
    const container = yield* Azure.Storage.BlobContainer("DevContainer", {
      storageAccount: account.storageAccountName,
      metadata,
    });
    return { account, container };
  });

const localContainer = (containerName: string) =>
  onAzurite(({ blob: url }) =>
    blob.GetContainerProperties({ url, containerName }).pipe(
      Effect.map((props) => ({ status: "found" as const, metadata: props.metadata ?? {} })),
      Effect.catchTag("ContainerNotFound", () =>
        Effect.succeed({ status: "gone" as const, metadata: {} as blob.HeaderCollection }),
      ),
    ),
  );

test.provider(
  "a local container lives in Azurite: create, update metadata, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ purpose: "uploads" }));
      // Local identities: Azurite's account and `dev:` ids.
      expect(created.account.storageAccountName).toBe("devstoreaccount1");
      expect(created.account.storageAccountId).toMatch(/^dev:/);
      expect(created.account.primaryEndpoints.blob).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(created.container.containerId).toMatch(/^dev:/);
      const name = created.container.containerName;

      // Out of band: the container is in Azurite with the ownership markers.
      const observed = yield* localContainer(name);
      expect(observed.status).toBe("found");
      expect(observed.metadata.purpose).toBe("uploads");
      expect(observed.metadata.alchemy_id).toBe("DevContainer");

      const updated = yield* stack.deploy(program({ purpose: "archive", owner: "ops" }));
      expect(updated.container.containerName).toBe(name);
      const reobserved = yield* localContainer(name);
      expect(reobserved.metadata.purpose).toBe("archive");
      expect(reobserved.metadata.owner).toBe("ops");

      yield* stack.destroy();
      expect((yield* localContainer(name)).status).toBe("gone");
    }),
  { timeout: 180_000 },
);

const remoteContainer = (resourceGroupName: string, accountName: string, containerName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage
      .GetBlobContainer({ subscriptionId, resourceGroupName, accountName, containerName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ContainerNotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
      );
  });

// ~$0.01; ~1 min (one Standard_LRS account).
test.provider(
  "Alchemy.remote() creates the account and container in Azure during dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program({ purpose: "remote" }).pipe(Alchemy.remote()));
      expect(deployed.account.storageAccountName).not.toBe("devstoreaccount1");
      expect(deployed.account.storageAccountId).toMatch(/^\/subscriptions\//);
      expect(deployed.container.containerId).toMatch(/^\/subscriptions\//);
      const where = [
        deployed.container.resourceGroup,
        deployed.account.storageAccountName,
        deployed.container.containerName,
      ] as const;
      expect(yield* remoteContainer(...where)).toBe("found");

      // Destroy deletes the live container and account (rows stamped `live`).
      yield* stack.destroy();
      const after = yield* remoteContainer(...where).pipe(
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
