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
  autoExportJobName: string,
) =>
  Effect.gen(function* () {
    return yield* storagecache.GetAutoExportJob({
      subscriptionId: yield* subscription,
      resourceGroupName,
      amlFilesystemName,
      autoExportJobName,
    });
  });

const program = (props: {
  autoExportPrefixes: string[];
  adminStatus: "Enable" | "Disable";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet, hsm, grants } = yield* lustreDependencies({
      hsm: true,
    });
    const fs = yield* Azure.StorageCache.AmlFilesystem("Lustre", {
      resourceGroup: group.resourceGroupName,
      sku: "AMLFS-Durable-Premium-500",
      storageCapacityTiB: 4,
      filesystemSubnet: subnet.subnetId,
      maintenanceWindow: { dayOfWeek: "Sunday", timeOfDayUTC: "22:00" },
      hsm,
      tags: { grants: grants ?? "" },
    });
    const job = yield* Azure.StorageCache.AutoExportJob("Export", {
      resourceGroup: group.resourceGroupName,
      amlFilesystem: fs.amlFilesystemName,
      autoExportPrefixes: props.autoExportPrefixes,
      adminStatus: props.adminStatus,
      tags: props.tags,
    });
    return { group, fs, job };
  });

// Needs a 4 TiB AMLFS-Durable-Premium-500 file system with blob integration
// (~$2-3/hour, 10-30 minutes to create, 5-20 minutes to delete): estimated
// ~$5 and ~60 minutes per run. Also needs AZURE_HPC_CACHE_RP_OBJECT_ID (see
// util.ts) and AMLFS quota, which free-trial subscriptions lack.
test.provider.skipIf(!runExpensive || !hpcCacheRpObjectId)(
  "create, update, replace, and delete an auto export job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fs, job } = yield* stack.deploy(
        program({ autoExportPrefixes: ["/"], adminStatus: "Enable" }),
      );
      const get = (name: string) =>
        getJob(group.resourceGroupName, fs.amlFilesystemName, name);
      expect(job.provisioningState).toEqual("Succeeded");
      const observed = yield* get(job.autoExportJobName);
      expect(observed.properties?.adminStatus).toEqual("Enable");
      expect(observed.properties?.autoExportPrefixes).toEqual(["/"]);

      // In place: disable the job and add a tag.
      const updated = yield* stack.deploy(
        program({
          autoExportPrefixes: ["/"],
          adminStatus: "Disable",
          tags: { team: "hpc" },
        }),
      );
      expect(updated.job.autoExportJobId).toEqual(job.autoExportJobId);
      const reobserved = yield* get(job.autoExportJobName);
      expect(reobserved.properties?.adminStatus).toEqual("Disable");
      expect(reobserved.tags?.team).toEqual("hpc");

      // Replacement: export prefixes are immutable.
      const replaced = yield* stack.deploy(
        program({
          autoExportPrefixes: ["/results"],
          adminStatus: "Disable",
          tags: { team: "hpc" },
        }),
      );
      expect(replaced.job.autoExportJobName).not.toEqual(job.autoExportJobName);
      const replacedObserved = yield* get(replaced.job.autoExportJobName);
      expect(replacedObserved.properties?.autoExportPrefixes).toEqual([
        "/results",
      ]);
      expect(yield* waitGone(get(job.autoExportJobName))).toEqual("gone");

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
  { tags, timeout: 900_000 },
);
