import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  customLocationId,
  logLevel,
  missingCustomLocation,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMarketplaceGalleryImage = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* hci.GetMarketplaceGalleryImage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      marketplaceGalleryImageName: name,
    });
  });

const program = (props: { second: boolean; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
    });
    const resource = yield* Azure.AzureStackHCI.MarketplaceGalleryImage(
      "MarketplaceGalleryImage",
      {
        resourceGroup: group.resourceGroupName,
        location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
        extendedLocation: { name: customLocationId() },
        ...(props.second
          ? {
              osType: "Linux",
              hyperVGeneration: "V2",
              identifier: {
                publisher: "canonical",
                offer: "0001-com-ubuntu-server-jammy",
                sku: "22_04-lts-gen2",
              },
              version: {
                name:
                  process.env.AZURE_TEST_HCI_MARKETPLACE_VERSION_2 ??
                  "22.04.202411010",
              },
            }
          : {
              osType: "Linux",
              hyperVGeneration: "V2",
              identifier: {
                publisher: "canonical",
                offer: "0001-com-ubuntu-server-jammy",
                sku: "22_04-lts-gen2",
              },
              version: {
                name:
                  process.env.AZURE_TEST_HCI_MARKETPLACE_VERSION ??
                  "22.04.202410020",
              },
            }),
        tags: props.tags,
      },
    );
    return { group, resource };
  });

// Downloading a marketplace image needs a deployed Azure Local cluster. The free trial
// has no Azure Local hardware; set AZURE_TEST_PAID=1 and
// AZURE_TEST_HCI_CUSTOM_LOCATION (plus the resource's inputs) on a
// subscription with an Azure Local cluster.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an Azure Local MarketplaceGalleryImage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, resource } = yield* stack.deploy(
        program({ second: false, tags: { env: "a" } }),
      );
      const get = (name: string) =>
        getMarketplaceGalleryImage(group.resourceGroupName, name);
      const observed = yield* get(resource.marketplaceGalleryImageName);
      expect(observed.properties?.osType).toEqual("Linux");
      expect(observed.tags?.env).toEqual("a");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ second: false, tags: { env: "b" } }),
      );
      expect(updated.resource.marketplaceGalleryImageId).toEqual(
        resource.marketplaceGalleryImageId,
      );
      expect(
        (yield* get(resource.marketplaceGalleryImageName)).tags?.env,
      ).toEqual("b");

      // Replacement: an immutable property changes.
      const replaced = yield* stack.deploy(
        program({ second: true, tags: { env: "b" } }),
      );
      expect(replaced.resource.marketplaceGalleryImageName).not.toEqual(
        resource.marketplaceGalleryImageName,
      );
      expect(
        yield* waitGone(get(resource.marketplaceGalleryImageName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.resource.marketplaceGalleryImageName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): without an Azure Local
// custom location the PUT is rejected with the typed error.
test.provider(
  "a missing custom location rejects the MarketplaceGalleryImage with a typed error",
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
      const error = yield* hci
        .MarketplaceGalleryImagesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          marketplaceGalleryImageName: "probe",
          location: "eastus",
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(
              subscriptionId,
              group.resourceGroupName,
            ),
          },
          properties: { osType: "Linux" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      const getError = yield* getMarketplaceGalleryImage(
        group.resourceGroupName,
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
