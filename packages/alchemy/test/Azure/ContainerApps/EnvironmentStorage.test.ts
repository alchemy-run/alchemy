import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

const { test } = Test.make({ providers: Azure.providers() });

const getStorage = (
  resourceGroupName: string,
  environmentName: string,
  storageName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetManagedEnvironmentsStorage({
      subscriptionId,
      resourceGroupName,
      environmentName,
      storageName,
    });
  });

const accountKey = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const result = yield* storage.ListStorageAccountKeys({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
    return result.keys?.[0]?.value ?? "";
  });

const program = (mount?: {
  accountKey: string;
  accessMode: "ReadOnly" | "ReadWrite";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const share = yield* Azure.Storage.FileShare("Share", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      shareQuota: 1,
    });
    const mounted =
      mount === undefined
        ? undefined
        : yield* Azure.ContainerApps.EnvironmentStorage("Mount", {
            resourceGroup: group.resourceGroupName,
            environment: env.environmentName,
            azureFile: {
              accountName: account.storageAccountName,
              accountKey: Redacted.make(mount.accountKey),
              shareName: share.shareName,
              accessMode: mount.accessMode,
            },
          });
    return { group, env, account, share, mounted };
  });

// Cost: Consumption environment (free idle) + a 1 GiB Standard_LRS file
// share for a few minutes (< $0.01).
// Gated (time, not cost): the trial allows one standard environment per
// subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "register, update, and delete an environment storage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The account key only exists once the account does.
      const base = yield* stack.deploy(program());
      const key = yield* accountKey(
        base.group.resourceGroupName,
        base.account.storageAccountName,
      );
      expect(key.length).toBeGreaterThan(0);

      const { group, env, share, mounted } = yield* stack.deploy(
        program({ accountKey: key, accessMode: "ReadOnly" }),
      );
      expect(mounted?.storageType).toEqual("AzureFile");
      expect(mounted?.accessMode).toEqual("ReadOnly");
      const storageName = mounted?.storageName ?? "";
      expect(storageName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);

      const observed = yield* getStorage(
        group.resourceGroupName,
        env.environmentName,
        storageName,
      );
      expect(observed.properties?.azureFile?.shareName).toEqual(
        share.shareName,
      );
      expect(observed.properties?.azureFile?.accessMode).toEqual("ReadOnly");

      // In-place update: access mode.
      const updated = yield* stack.deploy(
        program({ accountKey: key, accessMode: "ReadWrite" }),
      );
      expect(updated.mounted?.storageId).toEqual(mounted?.storageId);
      const reobserved = yield* getStorage(
        group.resourceGroupName,
        env.environmentName,
        storageName,
      );
      expect(reobserved.properties?.azureFile?.accessMode).toEqual("ReadWrite");

      // Removing it from the stack deletes only the storage.
      yield* stack.deploy(program());
      expect(
        yield* waitGone(
          getStorage(group.resourceGroupName, env.environmentName, storageName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
