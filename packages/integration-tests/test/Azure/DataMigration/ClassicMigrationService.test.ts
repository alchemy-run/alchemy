import * as Azure from "@alchemy.run/azure";
import * as datamigration from "@distilled.cloud/azure/datamigration";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (groupName: string, serviceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datamigration.GetService({ subscriptionId, groupName, serviceName });
  });

const serviceGone = (groupName: string, serviceName: string) =>
  getService(groupName, serviceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: { subnet: "one" | "two"; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location: "eastus" });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.62.0.0/16"],
    });
    const one = yield* Azure.Network.Subnet("One", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.62.1.0/24",
    });
    const two = yield* Azure.Network.Subnet("Two", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.62.2.0/24",
    });
    // Both subnets stay deployed across the replacement step below.
    const service = yield* Azure.DataMigration.ClassicMigrationService("Service", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      virtualSubnetId: props.subnet === "one" ? one.subnetId : two.subnetId,
      tags: props.tags,
    });
    return { group, one, two, service };
  });

// ~$0/run, 30-50 min: Standard_1vCores is free, but each classic service
// took more than 10 minutes to provision in eastus and this case creates
// two (the subnet change replaces the service).
test.provider.skipIf(!runExpensive)(
  "create, update tags, replace, and delete a classic migration service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, one, service } = yield* stack.deploy(
        program({ subnet: "one", tags: { env: "dev" } }),
      );
      const rg = group.resourceGroupName;
      expect(service.provisioningState).toEqual("Succeeded");
      expect(service.serviceId).toContain("/services/");
      expect(service.sku).toEqual("Standard_1vCores");
      expect(service.virtualSubnetId.toLowerCase()).toEqual(one.subnetId.toLowerCase());
      expect(service.tags).toEqual({ env: "dev" });
      const observed = yield* getService(rg, service.serviceName);
      expect(observed.sku?.name).toEqual("Standard_1vCores");
      expect(observed.tags?.env).toEqual("dev");

      // In-place tag update.
      const updated = yield* stack.deploy(program({ subnet: "one", tags: { env: "prod" } }));
      expect(updated.service.serviceId).toEqual(service.serviceId);
      const reobserved = yield* getService(rg, service.serviceName);
      expect(reobserved.tags?.env).toEqual("prod");

      // A subnet change replaces the service.
      const replaced = yield* stack.deploy(program({ subnet: "two", tags: { env: "prod" } }));
      expect(replaced.service.serviceName).not.toEqual(service.serviceName);
      expect(replaced.service.virtualSubnetId.toLowerCase()).toEqual(
        replaced.two.subnetId.toLowerCase(),
      );
      expect(yield* serviceGone(rg, service.serviceName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* serviceGone(rg, replaced.service.serviceName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:datamigration", "live"],
    timeout: 3_600_000,
  },
);
