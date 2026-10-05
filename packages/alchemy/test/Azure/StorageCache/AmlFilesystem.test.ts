import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as storagecache from "@distilled.cloud/azure/storagecache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  logLevel,
  lustreDependencies,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getFilesystem = (resourceGroupName: string, amlFilesystemName: string) =>
  Effect.gen(function* () {
    return yield* storagecache.GetAmlFilesystem({
      subscriptionId: yield* subscription,
      resourceGroupName,
      amlFilesystemName,
    });
  });

const program = (props: {
  storageCapacityTiB: number;
  maintenanceWindow: Azure.StorageCache.AmlFilesystemMaintenanceWindow;
  rootSquashSettings?: Azure.StorageCache.AmlFilesystemRootSquash;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* lustreDependencies({
      hsm: false,
      group: "alchemy-test-storagecache-amlfs",
    });
    const fs = yield* Azure.StorageCache.AmlFilesystem("Lustre", {
      resourceGroup: group.resourceGroupName,
      sku: "AMLFS-Durable-Premium-500",
      zones: ["1"],
      storageCapacityTiB: props.storageCapacityTiB,
      filesystemSubnet: subnet.subnetId,
      maintenanceWindow: props.maintenanceWindow,
      rootSquashSettings: props.rootSquashSettings,
      tags: props.tags,
    });
    return { group, fs };
  });

// Smallest file system is 4 TiB of AMLFS-Durable-Premium-500 (~$2-3/hour,
// billed hourly); creation takes 10-30 minutes and deletion 5-20 minutes.
// The replacement step briefly runs an 8 TiB file system next to it.
// Estimated ~$15 and ~60-90 minutes per run; free-trial subscriptions also
// lack AMLFS quota.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete an AML file system",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fs } = yield* stack.deploy(
        program({
          storageCapacityTiB: 4,
          maintenanceWindow: { dayOfWeek: "Sunday", timeOfDayUTC: "22:00" },
          tags: { env: "test" },
        }),
      );
      expect(fs.provisioningState).toEqual("Succeeded");
      expect(fs.mgsAddress).toBeDefined();
      const observed = yield* getFilesystem(
        group.resourceGroupName,
        fs.amlFilesystemName,
      );
      expect(observed.sku?.name).toEqual("AMLFS-Durable-Premium-500");
      expect(observed.properties?.storageCapacityTiB).toEqual(4);
      expect(observed.properties?.maintenanceWindow).toEqual({
        dayOfWeek: "Sunday",
        timeOfDayUTC: "22:00",
      });
      expect(observed.tags?.env).toEqual("test");

      // In place: maintenance window, root squash, and tags.
      const updated = yield* stack.deploy(
        program({
          storageCapacityTiB: 4,
          maintenanceWindow: { dayOfWeek: "Saturday", timeOfDayUTC: "03:30" },
          rootSquashSettings: {
            mode: "RootOnly",
            noSquashNidLists: "10.42.0.[4-5]@tcp",
            squashUID: 65534,
            squashGID: 65534,
          },
          tags: { env: "test", team: "hpc" },
        }),
      );
      expect(updated.fs.amlFilesystemId).toEqual(fs.amlFilesystemId);
      const reobserved = yield* getFilesystem(
        group.resourceGroupName,
        fs.amlFilesystemName,
      );
      expect(reobserved.properties?.maintenanceWindow).toEqual({
        dayOfWeek: "Saturday",
        timeOfDayUTC: "03:30",
      });
      expect(reobserved.properties?.rootSquashSettings?.mode).toEqual(
        "RootOnly",
      );
      expect(
        reobserved.properties?.rootSquashSettings?.noSquashNidLists,
      ).toEqual("10.42.0.[4-5]@tcp");
      expect(reobserved.tags?.team).toEqual("hpc");

      // Replacement: capacity can only grow through an expansion job.
      const replaced = yield* stack.deploy(
        program({
          storageCapacityTiB: 8,
          maintenanceWindow: { dayOfWeek: "Saturday", timeOfDayUTC: "03:30" },
          tags: { env: "test", team: "hpc" },
        }),
      );
      expect(replaced.fs.amlFilesystemName).not.toEqual(fs.amlFilesystemName);
      const replacedObserved = yield* getFilesystem(
        group.resourceGroupName,
        replaced.fs.amlFilesystemName,
      );
      expect(replacedObserved.properties?.storageCapacityTiB).toEqual(8);
      expect(
        yield* waitGone(
          getFilesystem(group.resourceGroupName, fs.amlFilesystemName),
          120,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getFilesystem(group.resourceGroupName, replaced.fs.amlFilesystemName),
          120,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);

// Ungated, free: the resource provider answers sizing queries, and a GET of
// a missing file system / job surfaces a typed not-found that the providers'
// read and delete treat as "gone".
test.provider(
  "AML file system lookups surface typed not-found errors",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageCache");

      const size = yield* storagecache.GetRequiredAmlFSSubnetsSize({
        subscriptionId,
        storageCapacityTiB: 4,
        sku: { name: "AMLFS-Durable-Premium-500" },
      });
      expect(size.filesystemSubnetSize).toBeGreaterThan(0);

      const missing = yield* getFilesystem(
        group.resourceGroupName,
        "alchemy-missing-amlfs",
      ).pipe(Effect.flip);
      expect(["ResourceNotFound", "NotFound"]).toContain(missing._tag);

      const missingJob = yield* storagecache
        .GetAutoExportJob({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          amlFilesystemName: "alchemy-missing-amlfs",
          autoExportJobName: "missing",
        })
        .pipe(Effect.flip);
      expect(["ResourceNotFound", "NotFound"]).toContain(missingJob._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
