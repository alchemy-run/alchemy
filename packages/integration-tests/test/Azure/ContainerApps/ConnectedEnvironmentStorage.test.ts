import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as app from "@distilled.cloud/azure/app";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  arcLocation,
  connectedEnvironmentStack,
  MISSING_ENVIRONMENT,
  probeGroup,
} from "./fixtures/connected.ts";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:containerapps", "live"];

const getStorage = (
  resourceGroupName: string,
  connectedEnvironmentName: string,
  storageName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetConnectedEnvironmentsStorage({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
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

const program = (mount?: { accountKey: string; accessMode: "ReadOnly" | "ReadWrite" }) =>
  Effect.gen(function* () {
    const { group, env } = yield* connectedEnvironmentStack;
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
      location: arcLocation,
    });
    const share = yield* Azure.Storage.FileShare("Share", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
      shareQuota: 1,
    });
    const mounted =
      mount === undefined
        ? undefined
        : yield* Azure.ContainerApps.ConnectedEnvironmentStorage("Mount", {
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

// ~cluster cost only + a 1 GiB file share (< $0.01), 20 min. Needs an
// Arc-enabled Kubernetes cluster with the Container Apps extension and a
// custom location (see fixtures/connected.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a connected environment storage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The share exists before the storage that mounts it.
      const base = yield* stack.deploy(program());
      const key = yield* accountKey(base.group.resourceGroupName, base.account.storageAccountName);

      const { group, env, mounted } = yield* stack.deploy(
        program({ accountKey: key, accessMode: "ReadWrite" }),
      );
      expect(mounted?.accessMode).toEqual("ReadWrite");
      const get = getStorage(
        group.resourceGroupName,
        env.environmentName,
        mounted?.storageName ?? "",
      );
      const observed = yield* get;
      expect(observed.properties?.azureFile?.shareName).toEqual(base.share.shareName);
      expect(observed.properties?.azureFile?.accessMode).toEqual("ReadWrite");

      // In-place update: access mode.
      const updated = yield* stack.deploy(program({ accountKey: key, accessMode: "ReadOnly" }));
      expect(updated.mounted?.storageId).toEqual(mounted?.storageId);
      expect((yield* get).properties?.azureFile?.accessMode).toEqual("ReadOnly");

      // Remove the storage while the environment stays.
      yield* stack.deploy(program());
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe (free, a resource group only): a storage under a missing
// connected environment is rejected with the typed error.
test.provider(
  "a missing connected environment rejects the storage with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const error = yield* app
        .ConnectedEnvironmentsStoragesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          connectedEnvironmentName: MISSING_ENVIRONMENT,
          storageName: "probe",
          properties: {
            azureFile: {
              accountName: "alchemymissing",
              accountKey: "a2V5",
              shareName: "share",
              accessMode: "ReadOnly",
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const mounted = yield* Azure.ContainerApps.ConnectedEnvironmentStorage("Mount", {
              resourceGroup: probe.group.resourceGroupName,
              environment: MISSING_ENVIRONMENT,
              azureFile: {
                accountName: "alchemymissing",
                accountKey: Redacted.make("a2V5"),
                shareName: "share",
                accessMode: "ReadOnly",
              },
            });
            return { mounted };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
