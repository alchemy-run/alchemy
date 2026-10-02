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

const getGroup = (resourceGroupName: string, serverTrustGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetServerTrustGroup({
      subscriptionId,
      resourceGroupName,
      locationName: LOCATION,
      serverTrustGroupName,
    });
  });

const groupGone = (resourceGroupName: string, serverTrustGroupName: string) =>
  getGroup(resourceGroupName, serverTrustGroupName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const program = (props: {
  password: Redacted.Redacted<string>;
  trustScopes: ("GlobalTransactions" | "ServiceBroker")[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
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
      addressPrefixes: ["10.46.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Mi", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.46.0.0/24",
      networkSecurityGroupId: nsg.networkSecurityGroupId,
      routeTableId: routes.routeTableId,
      delegations: [{ serviceName: "Microsoft.Sql/managedInstances" }],
    });
    const mi = {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      subnetId: subnet.subnetId,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
      sku: { name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" },
      vCores: 4,
      storageSizeInGB: 32,
      licenseType: "LicenseIncluded" as const,
    };
    const first = yield* Azure.Sql.ManagedInstance("First", mi);
    const second = yield* Azure.Sql.ManagedInstance("Second", mi);
    const trust = yield* Azure.Sql.ServerTrustGroup("Trust", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      groupMembers: [first.managedInstanceId, second.managedInstanceId],
      trustScopes: props.trustScopes,
    });
    return { group, first, second, trust };
  });

// Two 4 vCore General Purpose managed instances (~$1.40/hour together), the
// virtual cluster build takes 30 minutes to 6 hours, and 8 vCores exceed the
// free trial's regional quota. One run costs several dollars. Only runs with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a sql server trust group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, first, second, trust } = yield* stack.deploy(
        program({ password, trustScopes: ["GlobalTransactions"] }),
      );
      const observed = yield* getGroup(
        group.resourceGroupName,
        trust.serverTrustGroupName,
      );
      expect(
        (observed.properties?.groupMembers ?? [])
          .map((m) => m.serverId.toLowerCase())
          .sort(),
      ).toEqual(
        [first.managedInstanceId, second.managedInstanceId]
          .map((id) => id.toLowerCase())
          .sort(),
      );

      // Replacement: trust scopes cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          password,
          trustScopes: ["GlobalTransactions", "ServiceBroker"],
        }),
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        replaced.trust.serverTrustGroupName,
      );
      expect([...(reobserved.properties?.trustScopes ?? [])].sort()).toEqual([
        "GlobalTransactions",
        "ServiceBroker",
      ]);

      yield* stack.destroy();
      expect(
        yield* groupGone(
          group.resourceGroupName,
          replaced.trust.serverTrustGroupName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 12 * 3_600_000,
  },
);
