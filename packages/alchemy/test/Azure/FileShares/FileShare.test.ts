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

const getShare = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* fileshares.GetFileShare({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const shareGone = (resourceGroupName: string, resourceName: string) =>
  getShare(resourceGroupName, resourceName).pipe(
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
  mountName?: string;
  provisionedStorageGiB: number;
  rootSquash: Azure.FileShares.FileShareRootSquash;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const share = yield* Azure.FileShares.FileShare("Share", {
      resourceGroup: group.resourceGroupName,
      location,
      mountName: props.mountName,
      provisionedStorageGiB: props.provisionedStorageGiB,
      nfs: { rootSquash: props.rootSquash },
      publicNetworkAccess: "Disabled",
      tags: props.tags,
    });
    return { group, share };
  });

// 32-64 GiB SSD provisioned v2 share for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete a file share",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, share } = yield* stack.deploy(
        program({
          provisionedStorageGiB: 32,
          rootSquash: "NoRootSquash",
          tags: { env: "test" },
        }),
      );
      expect(share.fileShareName).toMatch(/^[a-z0-9-]{3,63}$/);
      expect(share.mountName).toEqual(share.fileShareName);
      expect(share.redundancy).toEqual("Local");
      expect(share.protocol).toEqual("NFS");
      expect(share.provisionedStorageGiB).toEqual(32);
      expect(share.tags).toEqual({ env: "test" });

      const observed = yield* getShare(
        group.resourceGroupName,
        share.fileShareName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(observed.properties?.nfsProtocolProperties?.rootSquash).toEqual(
        "NoRootSquash",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Share");

      // In-place update: storage increase, root squash, tags.
      const updated = yield* stack.deploy(
        program({
          provisionedStorageGiB: 64,
          rootSquash: "RootSquash",
          tags: { env: "prod" },
        }),
      );
      expect(updated.share.fileShareId).toEqual(share.fileShareId);
      expect(updated.share.provisionedStorageGiB).toEqual(64);
      const reobserved = yield* getShare(
        group.resourceGroupName,
        share.fileShareName,
      );
      expect(reobserved.properties?.provisionedStorageGiB).toEqual(64);
      expect(reobserved.properties?.nfsProtocolProperties?.rootSquash).toEqual(
        "RootSquash",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the mount name is immutable. Keep the size so the
      // replacement does not depend on the downgrade cooldown.
      const replaced = yield* stack.deploy(
        program({
          mountName: "replaced",
          provisionedStorageGiB: 64,
          rootSquash: "RootSquash",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.share.mountName).toEqual("replaced");
      const replacedObserved = yield* getShare(
        group.resourceGroupName,
        replaced.share.fileShareName,
      );
      expect(replacedObserved.properties?.mountName).toEqual("replaced");
      if (replaced.share.fileShareName !== share.fileShareName) {
        expect(
          yield* shareGone(group.resourceGroupName, share.fileShareName),
        ).toEqual("gone");
      }

      yield* stack.destroy();
      expect(
        yield* shareGone(group.resourceGroupName, replaced.share.fileShareName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:fileshares", "live"],
    timeout: 900_000,
  },
);
