import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getEndpoint = (
  resourceGroupName: string,
  factoryName: string,
  managedPrivateEndpointName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetManagedPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      factoryName,
      managedVirtualNetworkName: "default",
      managedPrivateEndpointName,
    });
  });

const endpointGone = (
  resourceGroupName: string,
  factoryName: string,
  managedPrivateEndpointName: string,
) =>
  getEndpoint(resourceGroupName, factoryName, managedPrivateEndpointName).pipe(
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

const program = (groupId: "blob" | "queue") =>
  Effect.gen(function* () {
    // Endpoint provisioning consistently ended in `Failed` when the target
    // sat in the ~90-character generated group name; a short name works.
    const group = yield* Azure.Resources.ResourceGroup("MpeGroup", {
      name: "alchemy-test-adf-mpe",
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("MpeAccount", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard_LRS",
    });
    const factory = yield* Azure.DataFactory.Factory("MpeFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const vnet = yield* Azure.DataFactory.ManagedVirtualNetwork("MpeVnet", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
    });
    const endpoint = yield* Azure.DataFactory.ManagedPrivateEndpoint(
      "StorageEndpoint",
      {
        resourceGroup: group.resourceGroupName,
        factoryName: factory.factoryName,
        managedVirtualNetworkName: vnet.managedVirtualNetworkName,
        privateLinkResourceId: account.storageAccountId,
        groupId,
      },
    );
    return { group, account, factory, endpoint };
  });

// ~$0.01: a Standard_LRS account plus a managed private endpoint (billed
// per hour only while a managed IR runs). ~8-12 minutes: each endpoint
// provisions asynchronously in 3-5 minutes and the test creates two.
test.provider(
  "create, replace, and delete a managed private endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, factory, endpoint } = yield* stack.deploy(
        program("blob"),
      );
      expect(endpoint.provisioningState).toEqual("Succeeded");
      expect(endpoint.groupId).toEqual("blob");
      const observed = yield* getEndpoint(
        group.resourceGroupName,
        factory.factoryName,
        endpoint.managedPrivateEndpointName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.privateLinkResourceId?.toLowerCase()).toEqual(
        account.storageAccountId.toLowerCase(),
      );
      expect(observed.properties.connectionState?.status).toEqual("Pending");

      // groupId is create-only: changing it replaces the endpoint.
      const replaced = yield* stack.deploy(program("queue"));
      expect(replaced.endpoint.managedPrivateEndpointName).not.toEqual(
        endpoint.managedPrivateEndpointName,
      );
      const replacedObserved = yield* getEndpoint(
        group.resourceGroupName,
        factory.factoryName,
        replaced.endpoint.managedPrivateEndpointName,
      );
      expect(replacedObserved.properties.groupId).toEqual("queue");
      expect(
        yield* endpointGone(
          group.resourceGroupName,
          factory.factoryName,
          endpoint.managedPrivateEndpointName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* endpointGone(
          group.resourceGroupName,
          factory.factoryName,
          replaced.endpoint.managedPrivateEndpointName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 900_000,
  },
);
