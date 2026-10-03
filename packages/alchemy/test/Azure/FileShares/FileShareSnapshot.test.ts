import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as fileshares from "@distilled.cloud/azure/fileshares";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "eastus";

const getSnapshot = (
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* fileshares.GetFileShareSnapshot({
      subscriptionId,
      resourceGroupName,
      resourceName,
      name,
    });
  });

const snapshotGone = (
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  getSnapshot(resourceGroupName, resourceName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  initiatorId: string;
  metadata: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const share = yield* Azure.FileShares.FileShare("Share", {
      resourceGroup: group.resourceGroupName,
      location,
      publicNetworkAccess: "Disabled",
    });
    const snapshot = yield* Azure.FileShares.FileShareSnapshot("Snapshot", {
      resourceGroup: group.resourceGroupName,
      fileShare: share.fileShareName,
      initiatorId: props.initiatorId,
      metadata: props.metadata,
    });
    return { group, share, snapshot };
  });

// 32 GiB SSD share plus a differential snapshot for a few minutes: < $0.05.
test.provider(
  "create, update, replace, and delete a file share snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, share, snapshot } = yield* stack.deploy(
        program({ initiatorId: "alchemy-test", metadata: { purpose: "v1" } }),
      );
      expect(snapshot.fileShare).toEqual(share.fileShareName);
      expect(snapshot.metadata).toEqual({ purpose: "v1" });
      expect(snapshot.initiatorId).toEqual("alchemy-test");

      const observed = yield* getSnapshot(
        group.resourceGroupName,
        share.fileShareName,
        snapshot.snapshotName,
      );
      expect(observed.properties?.metadata?.purpose).toEqual("v1");
      expect(observed.properties?.metadata?.alchemy_id).toEqual("Snapshot");

      // In-place update: metadata.
      const updated = yield* stack.deploy(
        program({ initiatorId: "alchemy-test", metadata: { purpose: "v2" } }),
      );
      expect(updated.snapshot.snapshotId).toEqual(snapshot.snapshotId);
      expect(updated.snapshot.metadata).toEqual({ purpose: "v2" });
      const reobserved = yield* getSnapshot(
        group.resourceGroupName,
        share.fileShareName,
        snapshot.snapshotName,
      );
      expect(reobserved.properties?.metadata?.purpose).toEqual("v2");

      // Replacement: the initiator is fixed when the snapshot is taken.
      const replaced = yield* stack.deploy(
        program({ initiatorId: "alchemy-test-2", metadata: { purpose: "v2" } }),
      );
      expect(replaced.snapshot.snapshotName).not.toEqual(snapshot.snapshotName);
      expect(replaced.snapshot.initiatorId).toEqual("alchemy-test-2");
      expect(
        yield* snapshotGone(
          group.resourceGroupName,
          share.fileShareName,
          snapshot.snapshotName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* snapshotGone(
          group.resourceGroupName,
          share.fileShareName,
          replaced.snapshot.snapshotName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:fileshares", "live"],
    timeout: 900_000,
  },
);
