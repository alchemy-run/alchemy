import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as storagemover from "@distilled.cloud/azure/storagemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  storageMoverName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    storagemover.GetConnection({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      connectionName,
    }),
  );

const program = (props: { description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const frontend = yield* Azure.Network.Subnet("Frontend", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
      privateLinkServiceNetworkPolicies: "Disabled",
    });
    const lb = yield* Azure.Network.LoadBalancer("Internal", {
      resourceGroup: group.resourceGroupName,
      frontendIpConfigurations: [
        { name: "internal", subnetId: frontend.subnetId },
      ],
    });
    const service = yield* Azure.Network.PrivateLinkService("Nas", {
      resourceGroup: group.resourceGroupName,
      loadBalancerFrontendIpConfigurationIds: [
        Output.interpolate`${lb.loadBalancerId}/frontendIPConfigurations/internal`,
      ],
      ipConfigurations: [
        { name: "nat", subnetId: frontend.subnetId, primary: true },
      ],
    });
    const mover = yield* Azure.StorageMover.StorageMover("Mover", {
      resourceGroup: group.resourceGroupName,
    });
    const connection = yield* Azure.StorageMover.Connection("Connection", {
      resourceGroup: group.resourceGroupName,
      storageMover: mover.storageMoverName,
      privateLinkServiceId: service.privateLinkServiceId,
      description: props.description,
    });
    return { group, service, mover, connection };
  });

// Internal Standard LB ~$0.025/hour + private link service; the test runs
// for a few minutes (< $0.01).
test.provider(
  "create, replace, and delete a storage mover connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, mover, connection } = yield* stack.deploy(
        program({ description: "first" }),
      );
      const get = () =>
        getConnection(
          group.resourceGroupName,
          mover.storageMoverName,
          connection.connectionName,
        );
      expect(connection.privateLinkServiceId.toLowerCase()).toEqual(
        service.privateLinkServiceId.toLowerCase(),
      );
      expect(connection.description).toEqual("first");
      const observed = yield* get();
      expect(observed.properties.privateLinkServiceId.toLowerCase()).toEqual(
        service.privateLinkServiceId.toLowerCase(),
      );
      expect(observed.properties.description).toMatch(
        /^first \[alchemy .+\/Connection\]$/,
      );

      expect(observed.properties.connectionStatus).toEqual("Pending");
      expect(connection.privateEndpointResourceId).toBeDefined();

      // Replacement: Azure ignores description changes on an existing
      // connection, so a new description replaces it.
      const replaced = yield* stack.deploy(program({ description: "second" }));
      expect(replaced.connection.connectionName).not.toEqual(
        connection.connectionName,
      );
      const getReplaced = () =>
        getConnection(
          group.resourceGroupName,
          mover.storageMoverName,
          replaced.connection.connectionName,
        );
      expect((yield* getReplaced()).properties.description).toMatch(
        /^second \[alchemy /,
      );
      expect(yield* waitGone(get())).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getReplaced())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
