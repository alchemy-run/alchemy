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

const PRIMARY = "centralus";
const SECONDARY = "eastus2";

const getGroup = (
  resourceGroupName: string,
  locationName: string,
  failoverGroupName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetInstanceFailoverGroup({
      subscriptionId,
      resourceGroupName,
      locationName,
      failoverGroupName,
    });
  });

const groupGone = (
  resourceGroupName: string,
  locationName: string,
  failoverGroupName: string,
) =>
  getGroup(resourceGroupName, locationName, failoverGroupName).pipe(
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

/** A Managed Instance subnet (NSG + route table + delegation) in `location`. */
const miSubnet = (
  prefix: string,
  resourceGroup: string,
  location: string,
  cidr: string,
) =>
  Effect.gen(function* () {
    const nsg = yield* Azure.Network.NetworkSecurityGroup(`${prefix}Nsg`, {
      resourceGroup,
      location,
    });
    const routes = yield* Azure.Network.RouteTable(`${prefix}Routes`, {
      resourceGroup,
      location,
    });
    const vnet = yield* Azure.Network.VirtualNetwork(`${prefix}Vnet`, {
      resourceGroup,
      location,
      addressPrefixes: [cidr],
    });
    return yield* Azure.Network.Subnet(`${prefix}Subnet`, {
      resourceGroup,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: cidr.replace("/16", "/24"),
      networkSecurityGroupId: nsg.networkSecurityGroupId,
      routeTableId: routes.routeTableId,
      delegations: [{ serviceName: "Microsoft.Sql/managedInstances" }],
    });
  });

const program = (props: {
  password: Redacted.Redacted<string>;
  failoverPolicy: "Manual" | "Automatic";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: PRIMARY,
    });
    const primarySubnet = yield* miSubnet(
      "Primary",
      group.resourceGroupName,
      PRIMARY,
      "10.44.0.0/16",
    );
    const secondarySubnet = yield* miSubnet(
      "Secondary",
      group.resourceGroupName,
      SECONDARY,
      "10.45.0.0/16",
    );
    const mi = {
      resourceGroup: group.resourceGroupName,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
      sku: { name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" },
      vCores: 4,
      storageSizeInGB: 32,
      licenseType: "LicenseIncluded" as const,
    };
    const primary = yield* Azure.Sql.ManagedInstance("Primary", {
      ...mi,
      location: PRIMARY,
      subnetId: primarySubnet.subnetId,
    });
    const secondary = yield* Azure.Sql.ManagedInstance("Secondary", {
      ...mi,
      location: SECONDARY,
      subnetId: secondarySubnet.subnetId,
      dnsZonePartner: primary.managedInstanceId,
    });
    const fog = yield* Azure.Sql.InstanceFailoverGroup("Fog", {
      resourceGroup: group.resourceGroupName,
      location: PRIMARY,
      partnerLocation: SECONDARY,
      managedInstancePair: {
        primaryManagedInstanceId: primary.managedInstanceId,
        partnerManagedInstanceId: secondary.managedInstanceId,
      },
      failoverPolicy: props.failoverPolicy,
      failoverWithDataLossGracePeriodMinutes:
        props.failoverPolicy === "Automatic" ? 60 : undefined,
    });
    return { group, primary, secondary, fog };
  });

// Two 4 vCore General Purpose managed instances in two regions (~$1.40/hour
// together), each building a virtual cluster (30 minutes to 6 hours), plus
// initial seeding. 8 vCores exceed the free trial's regional quota and one
// run costs well over $10. Only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a sql instance failover group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, fog } = yield* stack.deploy(
        program({ password, failoverPolicy: "Manual" }),
      );
      const observed = yield* getGroup(
        group.resourceGroupName,
        PRIMARY,
        fog.failoverGroupName,
      );
      expect(observed.properties?.readWriteEndpoint.failoverPolicy).toEqual(
        "Manual",
      );
      expect(observed.properties?.replicationRole).toEqual("Primary");

      // In place: automatic failover after an hour.
      yield* stack.deploy(program({ password, failoverPolicy: "Automatic" }));
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        PRIMARY,
        fog.failoverGroupName,
      );
      expect(reobserved.properties?.readWriteEndpoint.failoverPolicy).toEqual(
        "Automatic",
      );
      expect(
        reobserved.properties?.readWriteEndpoint
          .failoverWithDataLossGracePeriodMinutes,
      ).toEqual(60);

      yield* stack.destroy();
      expect(
        yield* groupGone(
          group.resourceGroupName,
          PRIMARY,
          fog.failoverGroupName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 12 * 3_600_000,
  },
);
