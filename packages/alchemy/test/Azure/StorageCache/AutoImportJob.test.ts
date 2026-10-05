import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagecache from "@distilled.cloud/azure/storagecache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  hpcCacheRpObjectId,
  logLevel,
  lustreDependencies,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getJob = (
  resourceGroupName: string,
  amlFilesystemName: string,
  autoImportJobName: string,
) =>
  Effect.gen(function* () {
    return yield* storagecache.GetAutoImportJob({
      subscriptionId: yield* subscription,
      resourceGroupName,
      amlFilesystemName,
      autoImportJobName,
    });
  });

const program = (props: {
  conflictResolutionMode: "Skip" | "OverwriteIfDirty";
  adminStatus: "Enable" | "Disable";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet, hsm, grants } = yield* lustreDependencies({
      hsm: true,
      group: "alchemy-test-storagecache-import",
    });
    const fs = yield* Azure.StorageCache.AmlFilesystem("Lustre", {
      resourceGroup: group.resourceGroupName,
      sku: "AMLFS-Durable-Premium-500",
      zones: ["1"],
      storageCapacityTiB: 4,
      filesystemSubnet: subnet.subnetId,
      maintenanceWindow: { dayOfWeek: "Sunday", timeOfDayUTC: "22:00" },
      hsm,
      tags: { grants: grants ?? "" },
    });
    const job = yield* Azure.StorageCache.AutoImportJob("Import", {
      resourceGroup: group.resourceGroupName,
      amlFilesystem: fs.amlFilesystemName,
      autoImportPrefixes: ["/"],
      conflictResolutionMode: props.conflictResolutionMode,
      adminStatus: props.adminStatus,
      tags: props.tags,
    });
    return { group, fs, job };
  });

// Needs a 4 TiB AMLFS-Durable-Premium-500 file system with blob integration
// (~$2-3/hour, 10-30 minutes to create, 5-20 minutes to delete) and a
// storage account with the blob change feed: estimated ~$5 and ~60 minutes
// per run. Also needs AZURE_HPC_CACHE_RP_OBJECT_ID (see util.ts) and AMLFS
// quota, which free-trial subscriptions lack.
test.provider.skipIf(!runExpensive || !hpcCacheRpObjectId)(
  "create, update, replace, and delete an auto import job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fs, job } = yield* stack.deploy(
        program({ conflictResolutionMode: "Skip", adminStatus: "Enable" }),
      );
      const get = (name: string) =>
        getJob(group.resourceGroupName, fs.amlFilesystemName, name);
      expect(job.provisioningState).toEqual("Succeeded");
      const observed = yield* get(job.autoImportJobName);
      expect(observed.properties?.adminStatus).toEqual("Enable");
      expect(observed.properties?.conflictResolutionMode).toEqual("Skip");

      // In place: disable the job and add a tag.
      const updated = yield* stack.deploy(
        program({
          conflictResolutionMode: "Skip",
          adminStatus: "Disable",
          tags: { team: "hpc" },
        }),
      );
      expect(updated.job.autoImportJobId).toEqual(job.autoImportJobId);
      const reobserved = yield* get(job.autoImportJobName);
      expect(reobserved.properties?.adminStatus).toEqual("Disable");
      expect(reobserved.tags?.team).toEqual("hpc");

      // Replacement: the conflict resolution mode is immutable.
      const replaced = yield* stack.deploy(
        program({
          conflictResolutionMode: "OverwriteIfDirty",
          adminStatus: "Disable",
          tags: { team: "hpc" },
        }),
      );
      expect(replaced.job.autoImportJobName).not.toEqual(job.autoImportJobName);
      const replacedObserved = yield* get(replaced.job.autoImportJobName);
      expect(replacedObserved.properties?.conflictResolutionMode).toEqual(
        "OverwriteIfDirty",
      );
      expect(yield* waitGone(get(job.autoImportJobName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          storagecache.GetAmlFilesystem({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            amlFilesystemName: fs.amlFilesystemName,
          }),
          120,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
