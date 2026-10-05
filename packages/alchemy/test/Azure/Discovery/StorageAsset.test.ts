import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAsset = (
  resourceGroupName: string,
  storageContainerName: string,
  storageAssetName: string,
) =>
  Effect.gen(function* () {
    return yield* discovery.GetStorageAsset({
      subscriptionId: yield* subscription,
      resourceGroupName,
      storageContainerName,
      storageAssetName,
    });
  });

const program = (props: { description: string; path: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const container = yield* Azure.Discovery.StorageContainer("Container", {
      resourceGroup: group.resourceGroupName,
      storageStore: {
        kind: "AzureStorageBlob",
        storageAccountId: account.storageAccountId,
      },
    });
    const asset = yield* Azure.Discovery.StorageAsset("Asset", {
      resourceGroup: group.resourceGroupName,
      storageContainer: container.storageContainerName,
      description: props.description,
      path: props.path,
    });
    return { group, container, asset };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// One Standard_LRS account plus control-plane registrations: ~$0.01 per
// run on an onboarded subscription with AZURE_TEST_PAID=1.
// Skipped: failed in the last live run. InvalidResourceType: The resource type could not be found
// in the namespace 'Microsoft.Discovery' for api version '2026-06-01'.
test.provider.skip(
  "create, update, replace, and delete a discovery storage asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, container, asset } = yield* stack.deploy(
        program({ description: "raw data", path: "raw" }),
      );
      const get = (name: string) =>
        getAsset(group.resourceGroupName, container.storageContainerName, name);
      const observed = yield* get(asset.storageAssetName);
      expect(observed.properties?.description).toEqual("raw data");
      expect(observed.properties?.path).toEqual("raw");

      // In place: description.
      const updated = yield* stack.deploy(
        program({ description: "curated data", path: "raw" }),
      );
      expect(updated.asset.storageAssetId).toEqual(asset.storageAssetId);
      const reobserved = yield* get(asset.storageAssetName);
      expect(reobserved.properties?.description).toEqual("curated data");

      // The path is create-only.
      const replaced = yield* stack.deploy(
        program({ description: "curated data", path: "curated" }),
      );
      expect(replaced.asset.storageAssetName).not.toEqual(
        asset.storageAssetName,
      );
      expect(
        (yield* get(replaced.asset.storageAssetName)).properties?.path,
      ).toEqual("curated");
      expect(yield* waitGone(get(asset.storageAssetName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.asset.storageAssetName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery storage assets are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const error = yield* discovery
        .StorageAssetsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          storageContainerName: "alchemy-probe",
          storageAssetName: "alchemy-probe",
          location,
          properties: { description: "probe" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
