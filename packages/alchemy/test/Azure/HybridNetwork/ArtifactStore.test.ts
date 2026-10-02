import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  storeType: Azure.HybridNetwork.ArtifactStoreType;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const publisher = yield* Azure.HybridNetwork.Publisher("Publisher", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const store = yield* Azure.HybridNetwork.ArtifactStore("Store", {
      resourceGroup: group.resourceGroupName,
      publisher: publisher.publisherName,
      location,
      storeType: props.storeType,
      tags: props.tags,
    });
    return { group, publisher, store };
  });

// Provisions a Standard container registry and then a storage account in
// AOSM-managed resource groups: well under $0.05 per run, ~10-15 minutes.
test.provider(
  "create, update, replace, and delete an artifact store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, publisher, store } = yield* stack.deploy(
        program({ storeType: "AzureContainerRegistry", tags: { env: "one" } }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetArtifactStore({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            publisherName: publisher.publisherName,
            artifactStoreName: name,
          });
        });
      expect(store.storeType).toEqual("AzureContainerRegistry");
      expect(store.storageResourceId).toContain(
        "Microsoft.ContainerRegistry/registries",
      );
      const observed = yield* get(store.artifactStoreName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("one");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ storeType: "AzureContainerRegistry", tags: { env: "two" } }),
      );
      expect(updated.store.artifactStoreId).toEqual(store.artifactStoreId);
      expect((yield* get(store.artifactStoreName)).tags?.env).toEqual("two");

      // Replacement: the store type is immutable.
      const replaced = yield* stack.deploy(
        program({ storeType: "AzureStorageAccount", tags: { env: "two" } }),
      );
      expect(replaced.store.artifactStoreName).not.toEqual(
        store.artifactStoreName,
      );
      expect(
        (yield* get(replaced.store.artifactStoreName)).properties?.storeType,
      ).toEqual("AzureStorageAccount");
      expect(yield* waitGone(get(store.artifactStoreName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.store.artifactStoreName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
