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

const getNetworkInterface = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* hci.GetNetworkInterface({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkInterfaceName: name,
    });
  });

const program = (props: { second: boolean; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
    });
    const resource = yield* Azure.AzureStackHCI.NetworkInterface(
      "NetworkInterface",
      {
        resourceGroup: group.resourceGroupName,
        location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
        extendedLocation: { name: customLocationId() },
        ...(props.second
          ? {
              ipConfigurations: [
                {
                  name: "ipconfig",
                  properties: {
                    subnet: { id: process.env.AZURE_TEST_HCI_LOGICAL_NETWORK! },
                  },
                },
              ],
              macAddress: "02:AB:CD:00:00:01",
            }
          : {
              ipConfigurations: [
                {
                  name: "ipconfig",
                  properties: {
                    subnet: { id: process.env.AZURE_TEST_HCI_LOGICAL_NETWORK! },
                  },
                },
              ],
            }),
        tags: props.tags,
      },
    );
    return { group, resource };
  });

// A network interface needs a deployed Azure Local cluster and logical network. The free trial
// has no Azure Local hardware; set AZURE_TEST_PAID=1 and
// AZURE_TEST_HCI_CUSTOM_LOCATION (plus the resource's inputs) on a
// subscription with an Azure Local cluster.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an Azure Local NetworkInterface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, resource } = yield* stack.deploy(
        program({ second: false, tags: { env: "a" } }),
      );
      const get = (name: string) =>
        getNetworkInterface(group.resourceGroupName, name);
      const observed = yield* get(resource.networkInterfaceName);
      expect(observed.properties?.ipConfigurations?.length).toEqual(1);
      expect(observed.tags?.env).toEqual("a");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ second: false, tags: { env: "b" } }),
      );
      expect(updated.resource.networkInterfaceId).toEqual(
        resource.networkInterfaceId,
      );
      expect((yield* get(resource.networkInterfaceName)).tags?.env).toEqual(
        "b",
      );

      // Replacement: an immutable property changes.
      const replaced = yield* stack.deploy(
        program({ second: true, tags: { env: "b" } }),
      );
      expect(replaced.resource.networkInterfaceName).not.toEqual(
        resource.networkInterfaceName,
      );
      expect(yield* waitGone(get(resource.networkInterfaceName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.resource.networkInterfaceName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): without an Azure Local
// custom location the PUT is rejected with the typed error.
test.provider(
  "a missing custom location rejects the NetworkInterface with a typed error",
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
        .NetworkInterfacesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          networkInterfaceName: "probe",
          location: "eastus",
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(
              subscriptionId,
              group.resourceGroupName,
            ),
          },
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      const getError = yield* getNetworkInterface(
        group.resourceGroupName,
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
