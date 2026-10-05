import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { randomUUID } from "node:crypto";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const LOCATION = "centralus";

const getInstance = (resourceGroupName: string, managedInstanceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetManagedInstance({
      subscriptionId,
      resourceGroupName,
      managedInstanceName,
    });
  });

const instanceGone = (resourceGroupName: string, managedInstanceName: string) =>
  getInstance(resourceGroupName, managedInstanceName).pipe(
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

const program = (props: {
  password: Redacted.Redacted<string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("MiNsg", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const routes = yield* Azure.Network.RouteTable("MiRoutes", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("MiVnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.42.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("MiSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.42.0.0/24",
      networkSecurityGroupId: nsg.networkSecurityGroupId,
      routeTableId: routes.routeTableId,
      delegations: [{ serviceName: "Microsoft.Sql/managedInstances" }],
    });
    const instance = yield* Azure.Sql.ManagedInstance("Mi", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      subnetId: subnet.subnetId,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
      sku: { name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" },
      vCores: 4,
      storageSizeInGB: 32,
      licenseType: "LicenseIncluded",
      tags: props.tags,
    });
    return { group, subnet, instance };
  });

// SQL Managed Instance: 4 vCore General Purpose (~$0.70/hour) and the first
// instance in a subnet builds a virtual cluster (30 minutes to 6 hours), so
// one run costs several dollars and takes hours. The 4 vCores also fill the
// free trial's regional quota. Only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a sql managed instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, subnet, instance } = yield* stack.deploy(
        program({ password, tags: { env: "test" } }),
      );
      expect(instance.provisioningState).toEqual("Succeeded");
      expect(instance.vCores).toEqual(4);
      const observed = yield* getInstance(
        group.resourceGroupName,
        instance.managedInstanceName,
      );
      expect(observed.properties?.subnetId?.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("test");

      // In place: tags.
      yield* stack.deploy(program({ password, tags: { env: "prod" } }));
      const reobserved = yield* getInstance(
        group.resourceGroupName,
        instance.managedInstanceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* instanceGone(
          group.resourceGroupName,
          instance.managedInstanceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 4 * 3_600_000,
  },
);
