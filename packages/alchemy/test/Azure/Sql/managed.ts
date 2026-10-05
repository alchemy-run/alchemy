import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

export const MANAGED_LOCATION = "centralus";

/**
 * SQL Managed Instance fixture: a delegated subnet (with the NSG and route
 * table MI requires) and a 4 vCore General Purpose instance.
 *
 * Cost/time: ~$0.70/hour, and the first instance in a subnet builds a
 * virtual cluster (30 minutes to 6 hours), so one run costs several
 * dollars and takes hours; the 4 vCores also fill the trial's regional
 * quota. Every managed-instance child test therefore only runs with
 * AZURE_TEST_EXPENSIVE=1.
 */
export const managedInstance = (
  password: Redacted.Redacted<string>,
  extra: Pick<Azure.Sql.ManagedInstanceProps, "identity"> = {},
  location: string = MANAGED_LOCATION,
) =>
  Effect.gen(function* () {
    const MANAGED_LOCATION = location;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: MANAGED_LOCATION,
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("MiNsg", {
      resourceGroup: group.resourceGroupName,
      location: MANAGED_LOCATION,
    });
    const routes = yield* Azure.Network.RouteTable("MiRoutes", {
      resourceGroup: group.resourceGroupName,
      location: MANAGED_LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("MiVnet", {
      resourceGroup: group.resourceGroupName,
      location: MANAGED_LOCATION,
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
      location: MANAGED_LOCATION,
      subnetId: subnet.subnetId,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: password,
      sku: { name: "GP_Gen5", tier: "GeneralPurpose", family: "Gen5" },
      vCores: 4,
      storageSizeInGB: 32,
      licenseType: "LicenseIncluded",
      ...extra,
    });
    return { group, vnet, subnet, instance };
  });

/** The managed instance fixture plus one empty database. */
export const managedDatabase = (
  password: Redacted.Redacted<string>,
  extra: Pick<Azure.Sql.ManagedInstanceProps, "identity"> = {},
) =>
  Effect.gen(function* () {
    const mi = yield* managedInstance(password, extra);
    const database = yield* Azure.Sql.ManagedDatabase("MiDb", {
      resourceGroup: mi.group.resourceGroupName,
      managedInstance: mi.instance.managedInstanceName,
    });
    return { ...mi, database };
  });
