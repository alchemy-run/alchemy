import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagemover from "@distilled.cloud/azure/storagemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getJob = (
  resourceGroupName: string,
  storageMoverName: string,
  projectName: string,
  jobDefinitionName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    storagemover.GetJobDefinition({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      projectName,
      jobDefinitionName,
    }),
  );

const program = (props: {
  copyMode: "Additive" | "Mirror";
  targetSubpath: string;
  description: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const container = yield* Azure.Storage.BlobContainer("Container", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    const mover = yield* Azure.StorageMover.StorageMover("Mover", {
      resourceGroup: group.resourceGroupName,
    });
    const project = yield* Azure.StorageMover.Project("Project", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
    });
    const target = yield* Azure.StorageMover.Endpoint("Target", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      endpointType: "AzureStorageBlobContainer",
      storageAccountId: account.storageAccountId,
      blobContainerName: container.containerName,
    });
    const source = yield* Azure.StorageMover.Endpoint("Source", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      endpointType: "NfsMount",
      host: "10.0.0.4",
      export: "/exports/data",
    });
    // No agent: one is only needed to start a job run.
    const job = yield* Azure.StorageMover.JobDefinition("Job", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      project: project.projectName,
      copyMode: props.copyMode,
      sourceName: source.endpointName,
      targetName: target.endpointName,
      targetSubpath: props.targetSubpath,
      description: props.description,
    });
    return { group, mover, project, source, target, job };
  });

// Storage account (Standard_LRS, empty) + Storage Mover: ~$0 per run, a few
// minutes.
test.provider(
  "create, update, replace, and delete a storage mover job definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, mover, project, source, target, job } =
        yield* stack.deploy(
          program({
            copyMode: "Additive",
            targetSubpath: "a",
            description: "first",
          }),
        );
      const get = (name: string) =>
        getJob(
          group.resourceGroupName,
          mover.storageMoverName,
          project.projectName,
          name,
        );
      expect(job.copyMode).toEqual("Additive");
      expect(job.sourceResourceId?.toLowerCase()).toEqual(
        source.endpointId.toLowerCase(),
      );
      expect(job.targetResourceId?.toLowerCase()).toEqual(
        target.endpointId.toLowerCase(),
      );
      const observed = yield* get(job.jobDefinitionName);
      expect(observed.properties.targetSubpath).toEqual("a");
      expect(observed.properties.description).toMatch(
        /^first \[alchemy .+\/Job\]$/,
      );

      // In-place: description and copy mode.
      const updated = yield* stack.deploy(
        program({
          copyMode: "Mirror",
          targetSubpath: "a",
          description: "second",
        }),
      );
      expect(updated.job.jobDefinitionId).toEqual(job.jobDefinitionId);
      const reobserved = yield* get(job.jobDefinitionName);
      expect(reobserved.properties.copyMode).toEqual("Mirror");
      expect(reobserved.properties.description).toMatch(/^second \[alchemy /);

      // Replacement: the target subpath is immutable.
      const replaced = yield* stack.deploy(
        program({
          copyMode: "Mirror",
          targetSubpath: "b",
          description: "second",
        }),
      );
      expect(replaced.job.jobDefinitionName).not.toEqual(job.jobDefinitionName);
      expect(
        (yield* get(replaced.job.jobDefinitionName)).properties.targetSubpath,
      ).toEqual("b");
      expect(yield* waitGone(get(job.jobDefinitionName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.job.jobDefinitionName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
