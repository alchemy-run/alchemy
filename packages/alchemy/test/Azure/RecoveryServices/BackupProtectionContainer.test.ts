import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  createVault,
  deleteVault,
  groupOnly,
  logLevel,
  subscription,
  tags,
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-container";

const program = (props: {
  account: "A" | "B";
  lock: "Acquire" | "NotAcquire";
}) =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    // Both accounts stay deployed across the replacement step.
    const a = yield* Azure.Storage.StorageAccount("AccountA", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard_LRS",
    });
    const b = yield* Azure.Storage.StorageAccount("AccountB", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard_LRS",
    });
    const account = props.account === "A" ? a : b;
    const container = yield* Azure.RecoveryServices.BackupProtectionContainer(
      "Container",
      {
        resourceGroup: group.resourceGroupName,
        vault: VAULT,
        sourceResourceId: account.storageAccountId,
        acquireStorageAccountLock: props.lock,
      },
    );
    return { group, owner, account, container };
  });

const getContainer = (resourceGroupName: string, containerName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetProtectionContainer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
      fabricName: "Azure",
      containerName,
    });
  });

/** Registration status, or "gone" once the container is unregistered. */
const status = (resourceGroupName: string, containerName: string) =>
  getContainer(resourceGroupName, containerName).pipe(
    Effect.map((c) => c.properties?.registrationStatus ?? "unknown"),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone"),
    ),
  );

// Vault is free; two Standard_LRS accounts with no data cost ~nothing.
// ~6 minutes (container registration is asynchronous).
test.provider(
  "register, update, replace, and unregister a storage container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      // Create: register account A without the delete lock.
      const created = yield* stack.deploy(
        program({ account: "A", lock: "NotAcquire" }),
      );
      expect(created.container.containerName).toEqual(
        `StorageContainer;Storage;${rg};${created.account.storageAccountName}`,
      );
      expect(created.container.registrationStatus).toEqual("Registered");
      const observed = yield* getContainer(rg, created.container.containerName);
      expect(observed.properties?.registrationStatus).toEqual("Registered");
      expect(observed.properties?.sourceResourceId?.toLowerCase()).toEqual(
        created.account.storageAccountId.toLowerCase(),
      );

      // In-place: acquire the storage account delete lock.
      const updated = yield* stack.deploy(
        program({ account: "A", lock: "Acquire" }),
      );
      expect(updated.container.containerId).toEqual(
        created.container.containerId,
      );
      const locked = yield* getContainer(rg, created.container.containerName);
      expect(locked.properties?.registrationStatus).toEqual("Registered");

      // Replacement: a different storage account is a different container.
      const replaced = yield* stack.deploy(
        program({ account: "B", lock: "NotAcquire" }),
      );
      expect(replaced.container.containerName).not.toEqual(
        created.container.containerName,
      );
      expect(yield* status(rg, replaced.container.containerName)).toEqual(
        "Registered",
      );
      expect(yield* status(rg, created.container.containerName)).not.toEqual(
        "Registered",
      );

      // Delete: unregister, then the accounts (and any released backup
      // lock) must delete cleanly.
      yield* stack.deploy(groupOnly);
      expect(yield* status(rg, replaced.container.containerName)).not.toEqual(
        "Registered",
      );

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
