import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const LOCATION = "centralus";

const getPool = (resourceGroupName: string, instancePoolName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetInstancePool({
      subscriptionId,
      resourceGroupName,
      instancePoolName,
    });
  });

const poolGone = (resourceGroupName: string, instancePoolName: string) =>
  getPool(resourceGroupName, instancePoolName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("60 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    // SQL Managed Instance subnets need an NSG, a route table, and the
    // `Microsoft.Sql/managedInstances` delegation.
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const routes = yield* Azure.Network.RouteTable("Routes", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.43.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("PoolSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.43.0.0/24",
      networkSecurityGroupId: nsg.networkSecurityGroupId,
      routeTableId: routes.routeTableId,
      delegations: [{ serviceName: "Microsoft.Sql/managedInstances" }],
    });
    const pool = yield* Azure.Sql.InstancePool("Pool", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      subnetId: subnet.subnetId,
      vCores: 8,
      licenseType: "LicenseIncluded",
      tags: props.tags,
    });
    return { group, subnet, pool };
  });

// SQL Managed Instance pool: the smallest pool is 8 vCores General Purpose
// (~$1.40/hour), building its virtual cluster takes 30 minutes to 6 hours,
// and 8 vCores exceed the free trial's ~4 regional vCPU quota. One run costs
// several dollars. Only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a sql instance pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, pool } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(pool.vCores).toEqual(8);
      const observed = yield* getPool(
        group.resourceGroupName,
        pool.instancePoolName,
      );
      expect(observed.properties?.subnetId?.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("test");

      // In place: tags.
      yield* stack.deploy(program({ tags: { env: "prod" } }));
      const reobserved = yield* getPool(
        group.resourceGroupName,
        pool.instancePoolName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* poolGone(group.resourceGroupName, pool.instancePoolName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 4 * 3_600_000,
  },
);
