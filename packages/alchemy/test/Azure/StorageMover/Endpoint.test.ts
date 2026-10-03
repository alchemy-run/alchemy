import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storagemover from "@distilled.cloud/azure/storagemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  storageMoverName: string,
  endpointName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    storagemover.GetEndpoint({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      endpointName,
    }),
  );

const program = (props: { exportPath: string; description: string }) =>
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
    const target = yield* Azure.StorageMover.Endpoint("Target", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      endpointType: "AzureStorageBlobContainer",
      storageAccountId: account.storageAccountId,
      blobContainerName: container.containerName,
      description: props.description,
    });
    // NFS hosts are not validated until a job runs.
    const source = yield* Azure.StorageMover.Endpoint("Source", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      endpointType: "NfsMount",
      host: "10.0.0.4",
      export: props.exportPath,
      nfsVersion: "NFSv4",
      description: props.description,
    });
    return { group, account, container, mover, target, source };
  });

// Storage account (Standard_LRS, empty) + Storage Mover: ~$0 per run, a few
// minutes.
test.provider(
  "create, update, replace, and delete storage mover endpoints",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, container, mover, target, source } =
        yield* stack.deploy(
          program({ exportPath: "/exports/a", description: "first" }),
        );
      const get = (name: string) =>
        getEndpoint(group.resourceGroupName, mover.storageMoverName, name);
      expect(target.endpointType).toEqual("AzureStorageBlobContainer");
      expect(target.endpointKind).toEqual("Target");
      expect(source.endpointType).toEqual("NfsMount");
      expect(source.endpointKind).toEqual("Source");
      const observedTarget = yield* get(target.endpointName);
      expect(observedTarget.properties.blobContainerName).toEqual(
        container.containerName,
      );
      expect(
        observedTarget.properties.storageAccountResourceId?.toLowerCase(),
      ).toEqual(account.storageAccountId.toLowerCase());
      expect(observedTarget.properties.description).toMatch(
        /^first \[alchemy .+\/Target\]$/,
      );
      const observedSource = yield* get(source.endpointName);
      expect(observedSource.properties.host).toEqual("10.0.0.4");
      expect(observedSource.properties.export).toEqual("/exports/a");
      expect(observedSource.properties.nfsVersion).toEqual("NFSv4");

      // In-place: descriptions.
      const updated = yield* stack.deploy(
        program({ exportPath: "/exports/a", description: "second" }),
      );
      expect(updated.target.endpointId).toEqual(target.endpointId);
      expect(updated.source.endpointId).toEqual(source.endpointId);
      expect((yield* get(target.endpointName)).properties.description).toMatch(
        /^second \[alchemy /,
      );
      expect((yield* get(source.endpointName)).properties.description).toMatch(
        /^second \[alchemy /,
      );

      // Replacement: the NFS export is immutable.
      const replaced = yield* stack.deploy(
        program({ exportPath: "/exports/b", description: "second" }),
      );
      expect(replaced.source.endpointName).not.toEqual(source.endpointName);
      expect(
        (yield* get(replaced.source.endpointName)).properties.export,
      ).toEqual("/exports/b");
      expect(replaced.target.endpointId).toEqual(target.endpointId);
      expect(yield* waitGone(get(source.endpointName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.source.endpointName))).toEqual(
        "gone",
      );
      expect(yield* waitGone(get(target.endpointName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
