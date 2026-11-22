import * as compute from "@distilled.cloud/azure/compute";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  canonical,
  createComputeName,
  ref,
  sameId,
  sameSet,
  waitComputeGone,
  whileComputeBusy,
} from "./common.ts";
import type { VirtualMachineIdentity, VirtualMachineImage } from "./VirtualMachine.ts";

export interface VirtualMachineScaleSetProps {
  /**
   * Resource group the scale set is created in. Changing it replaces the
   * scale set.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the scale set: 1-64 letters, digits, `.`, `_`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the scale set.
   */
  name?: string;
  /**
   * Azure location of the scale set. Changing it replaces the scale set.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zones to spread instances over, e.g. `["1", "2", "3"]`.
   * Changing them replaces the scale set.
   * @default no zones (regional)
   */
  zones?: string[];
  /**
   * Orchestration mode. `Flexible` instances are regular VMs; `Uniform`
   * instances are identical, scale-set-managed VMs. Changing it replaces the
   * scale set.
   * @default "Flexible"
   */
  orchestrationMode?: "Flexible" | "Uniform";
  /**
   * Fault domain count. Changing it replaces the scale set.
   * @default 1
   */
  platformFaultDomainCount?: number;
  /**
   * ARM ID of a proximity placement group
   * (`ppg.proximityPlacementGroupId`). Changing it replaces the scale set.
   * @default no proximity placement group
   */
  proximityPlacementGroupId?: string;
  /**
   * VM size of the instances, e.g. `Standard_B1s` or `Standard_D2s_v5`.
   * A change updates the scale set model; existing instances pick it up on
   * upgrade (`upgradePolicyMode`). Allowed sizes vary by region and
   * subscription.
   */
  vmSize: string;
  /**
   * Number of instances, 0 or more. Scaling happens in place.
   * @default 1
   */
  capacity?: number;
  /**
   * How model changes roll out to existing instances: `Manual` (you
   * upgrade each instance), `Automatic` (Azure upgrades them all), or
   * `Rolling` (in batches; needs a health probe or the Application Health
   * extension). Changes in place.
   * @default "Manual"
   */
  upgradePolicyMode?: "Manual" | "Automatic" | "Rolling";
  /**
   * OS image. Changing it replaces the scale set.
   * @default Ubuntu 24.04 LTS (`Canonical` / `ubuntu-24_04-lts` / `server` / `latest`)
   */
  image?: VirtualMachineImage;
  /**
   * Storage type of the instances' managed OS disks. Changing it replaces
   * the scale set.
   * @default "Standard_LRS"
   */
  osDiskStorageAccountType?:
    | "Standard_LRS"
    | "StandardSSD_LRS"
    | "Premium_LRS"
    | "StandardSSD_ZRS"
    | "Premium_ZRS";
  /**
   * ARM ID of the subnet the instances' primary NIC joins
   * (`subnet.subnetId`). Changing it replaces the scale set.
   */
  subnetId: string;
  /**
   * ARM ID of a network security group for the instances' NICs
   * (`nsg.networkSecurityGroupId`). Changing it replaces the scale set.
   * @default no NSG on the NICs
   */
  networkSecurityGroupId?: string;
  /**
   * ARM IDs of load balancer backend pools the instances join
   * (`lb.backendAddressPoolIds.<pool>`). Changing them replaces the scale set.
   * @default no backend pools
   */
  loadBalancerBackendAddressPoolIds?: string[];
  /**
   * Administrator user name. Changing it replaces the scale set.
   */
  adminUsername: string;
  /**
   * Administrator password (required for Windows). Setting or removing
   * it replaces the scale set. On Linux with `sshPublicKeys`, omitting it
   * turns off password sign-in.
   */
  adminPassword?: Redacted.Redacted<string>;
  /**
   * OpenSSH public keys authorised for `adminUsername` (Linux), written to
   * `/home/{adminUsername}/.ssh/authorized_keys`. Changing them replaces the
   * scale set.
   */
  sshPublicKeys?: string[];
  /**
   * Prefix of the instances' host names (Windows: at most 9 characters).
   * Changing it replaces the scale set.
   * @default the first 9 characters of the scale set name
   */
  computerNamePrefix?: string;
  /**
   * Base64-encoded custom data (cloud-init on Linux), at most 65,535
   * bytes before encoding. Changing it replaces the scale set.
   */
  customData?: string;
  /**
   * Enable boot diagnostics with managed storage. Updated in place.
   * @default false
   */
  bootDiagnostics?: boolean;
  /**
   * Managed identities of the instances. Updated in place.
   * @default no identity
   */
  identity?: VirtualMachineIdentity;
  /**
   * Instance priority. Changing it replaces the scale set.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot" | "Low";
  /**
   * What happens to evicted Spot instances: `Deallocate` (keep the disks)
   * or `Delete`. Changing it replaces the scale set.
   * @default Azure's default for Spot (`Deallocate`)
   */
  evictionPolicy?: "Deallocate" | "Delete";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface VirtualMachineScaleSet extends Resource<
  "Azure.Compute.VirtualMachineScaleSet",
  VirtualMachineScaleSetProps,
  {
    /** Name of the scale set. */
    virtualMachineScaleSetName: string;
    /** ARM resource ID of the scale set. */
    virtualMachineScaleSetId: string;
    /** Immutable unique ID Azure assigned to the scale set. */
    uniqueId: string | undefined;
    /** Resource group that holds the scale set. */
    resourceGroup: string;
    /** Location of the scale set. */
    location: string;
    /** Zones of the scale set. */
    zones: string[];
    /** Orchestration mode: `Flexible` or `Uniform`. */
    orchestrationMode: string | undefined;
    /** VM size of the instances. */
    vmSize: string | undefined;
    /** Number of instances. */
    capacity: number | undefined;
    /**
     * Instance IDs of a `Uniform` scale set's VMs (e.g. `["0", "1"]`),
     * sorted. Empty for `Flexible` scale sets, whose instances are regular
     * VMs.
     */
    instanceIds: string[];
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Creation time (ISO 8601). */
    timeCreated: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual machine scale set (`Microsoft.Compute/virtualMachineScaleSets`):
 * a group of VMs built from one model, whose instance count scales in
 * place. Put it behind a load balancer to serve one app from many VMs.
 *
 * Alchemy creates a `Flexible` scale set of one Ubuntu 24.04 LTS instance
 * with a `Standard_LRS` OS disk, no public IP, and a `Manual` upgrade
 * policy. Linux instances that get `sshPublicKeys` and no `adminPassword`
 * only accept SSH keys. Instances' OS disks and NICs are deleted with the
 * scale set.
 *
 * Model changes (`vmSize`, boot diagnostics) apply to new instances;
 * existing instances follow the `upgradePolicyMode`.
 *
 * :::caution[Changing the image, network, OS profile, or placement replaces the scale set]
 * That covers `name`, `resourceGroup`, `location`, `zones`,
 * `orchestrationMode`, `platformFaultDomainCount`,
 * `proximityPlacementGroupId`, `image`, `osDiskStorageAccountType`,
 * `subnetId`, `networkSecurityGroupId`, `loadBalancerBackendAddressPoolIds`,
 * `adminUsername`, `adminPassword` (set or unset), `sshPublicKeys`,
 * `computerNamePrefix`, `customData`, `priority`, and `evictionPolicy`.
 * Alchemy creates a new scale set with new instances, private IPs, and
 * empty OS disks, then deletes the old one with every instance and disk.
 * :::
 *
 * :::caution[Each instance counts against the regional vCPU quota]
 * A fresh subscription has a low vCPU quota per VM family and region, and
 * a create or scale-out fails when it runs out. Alchemy registers the
 * `Microsoft.Compute` resource provider before the first scale set.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-machine-scale-sets/overview
 *
 * ### Creating a Scale Set
 * **Example:** Flexible scale set with two Linux instances
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("web", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   vmSize: "Standard_B1s",
 *   capacity: 2,
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * **Example:** Fixed name, region, image, and Premium SSD disks
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   name: "vmss-web-prod",
 *   location: "westeurope",
 *   vmSize: "Standard_D2s_v5",
 *   image: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server" },
 *   osDiskStorageAccountType: "Premium_LRS",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   tags: { tier: "web" },
 * });
 * ```
 *
 * **Example:** Windows instances with a password
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("win", {
 *   vmSize: "Standard_D2s_v5",
 *   image: {
 *     publisher: "MicrosoftWindowsServer",
 *     offer: "WindowsServer",
 *     sku: "2022-datacenter-azure-edition",
 *   },
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   adminPassword: Redacted.make(password),
 *   computerNamePrefix: "win",
 * });
 * ```
 *
 * ### Scaling
 * Change `capacity` to scale in place. Change `vmSize` to update the model;
 * with `upgradePolicyMode: "Automatic"` Azure moves existing instances to
 * the new size, and with `"Manual"` only new instances get it.
 *
 * **Example:** Scale out to five instances
 * ```diff
 *  const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *    vmSize: "Standard_B1s",
 * -  capacity: 2,
 * +  capacity: 5,
 *    subnetId: subnet.subnetId,
 *    adminUsername: "azureuser",
 *    sshPublicKeys: [publicKey],
 *  });
 * ```
 *
 * ### Bootstrapping Instances
 * **Example:** cloud-init through `customData`
 * ```typescript
 * const cloudInit = "#cloud-config\npackages:\n  - nginx\n";
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   vmSize: "Standard_B1s",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   customData: Buffer.from(cloudInit).toString("base64"),
 * });
 * ```
 *
 * **Example:** Custom Script extension
 * ```typescript
 * yield* Azure.Compute.VirtualMachineScaleSetExtension("bootstrap", {
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   settings: { commandToExecute: "apt-get install -y nginx" },
 * });
 * ```
 *
 * ### Behind a Load Balancer
 * **Example:** Zone-redundant instances in a load balancer backend pool
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("web");
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   frontendIpConfigurations: [{ name: "public", publicIpAddressId: ip.publicIpAddressId }],
 *   backendAddressPools: [{ name: "web" }],
 *   probes: [{ name: "http", protocol: "Http", port: 80, requestPath: "/" }],
 *   loadBalancingRules: [
 *     {
 *       name: "http",
 *       frontendIpConfiguration: "public",
 *       backendAddressPool: "web",
 *       probe: "http",
 *       protocol: "Tcp",
 *       frontendPort: 80,
 *       backendPort: 80,
 *     },
 *   ],
 * });
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   vmSize: "Standard_B2s",
 *   capacity: 3,
 *   zones: ["1", "2", "3"],
 *   subnetId: subnet.subnetId,
 *   loadBalancerBackendAddressPoolIds: [lb.backendAddressPoolIds.web],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   upgradePolicyMode: "Automatic",
 * });
 * ```
 *
 * **Example:** Health probe for rolling upgrades
 * ```typescript
 * yield* Azure.Compute.VirtualMachineScaleSetExtension("health", {
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   publisher: "Microsoft.ManagedServices",
 *   type: "ApplicationHealthLinux",
 *   typeHandlerVersion: "1.0",
 *   settings: { protocol: "http", port: 80, requestPath: "/healthz" },
 * });
 * ```
 *
 * ### Network Security
 * **Example:** Allow only HTTP into the instances
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web");
 * yield* Azure.Network.SecurityRule("allow-http", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   sourceAddressPrefix: "Internet",
 *   destinationPortRange: "80",
 * });
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   vmSize: "Standard_B1s",
 *   subnetId: subnet.subnetId,
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * ### Identity
 * **Example:** Let the instances read blobs with a managed identity
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   vmSize: "Standard_B1s",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   identity: { systemAssigned: true },
 * });
 * yield* Azure.Authorization.RoleAssignment("web-reads-files", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: scaleSet.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Placement and Spot Instances
 * **Example:** Uniform scale set of Spot instances
 * ```typescript
 * const batch = yield* Azure.Compute.VirtualMachineScaleSet("batch", {
 *   orchestrationMode: "Uniform",
 *   vmSize: "Standard_D2s_v5",
 *   capacity: 4,
 *   priority: "Spot",
 *   evictionPolicy: "Delete",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * // batch.instanceIds, e.g. ["0", "1", "2", "3"]
 * ```
 *
 * **Example:** Instances close together in a proximity placement group
 * ```typescript
 * const ppg = yield* Azure.Compute.ProximityPlacementGroup("hpc", {
 *   zones: ["1"],
 *   intentVmSizes: ["Standard_D2s_v5"],
 * });
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("hpc", {
 *   vmSize: "Standard_D2s_v5",
 *   capacity: 4,
 *   zones: ["1"],
 *   proximityPlacementGroupId: ppg.proximityPlacementGroupId,
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * ### Binding to a runtime
 * Each power action is its own binding. A binding creates a custom role
 * with only that action (for example `AzureComputeScaleSetRestartRole` with
 * `virtualMachineScaleSets/restart/action`) and assigns it on this scale set
 * only. On an Azure Function, Web App, Container App, container group, VM,
 * or AKS workload identity the role goes to the host's managed identity;
 * any other host gets an Entra service principal.
 *
 * **Example:** Restart the scale set from an Azure Function
 * ```typescript
 * const Workers = Azure.Compute.VirtualMachineScaleSet("Workers", {
 *   vmSize: "Standard_B1s",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workers = yield* Workers;
 *     const restart = yield* Azure.Compute.RestartVirtualMachineScaleSet(workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* restart();
 *         return HttpServerResponse.text("accepted");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.RestartVirtualMachineScaleSetHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * Each call returns when Azure accepts it (HTTP 202); the instances change
 * state in the background. Omit `instanceIds` to act on every instance.
 *
 * **Example:** Stop billing at night and start again in the morning
 * ```typescript
 * // init
 * const deallocate = yield* Azure.Compute.DeallocateVirtualMachineScaleSet(workers);
 * const start = yield* Azure.Compute.StartVirtualMachineScaleSet(workers);
 *
 * // runtime
 * yield* deallocate();
 * yield* start();
 * // …provided with Effect.provide([Azure.Compute.DeallocateVirtualMachineScaleSetHttp, Azure.Compute.StartVirtualMachineScaleSetHttp])
 * ```
 *
 * **Example:** Power off or redeploy chosen instances of a Uniform scale set
 * ```typescript
 * // init
 * const powerOff = yield* Azure.Compute.PowerOffVirtualMachineScaleSet(batch);
 * const redeploy = yield* Azure.Compute.RedeployVirtualMachineScaleSet(batch);
 *
 * // runtime: IDs from batch.instanceIds
 * yield* powerOff({ instanceIds: ["0"], skipShutdown: true });
 * yield* redeploy({ instanceIds: ["1"] });
 * // …provided with Effect.provide([Azure.Compute.PowerOffVirtualMachineScaleSetHttp, Azure.Compute.RedeployVirtualMachineScaleSetHttp])
 * ```
 *
 * A powered-off instance still bills for compute; a deallocated one does
 * not.
 *
 * @resource
 */
export const VirtualMachineScaleSet = GroupedResource<VirtualMachineScaleSet>(
  "Azure.Compute.VirtualMachineScaleSet",
);

type Observed = compute.GetVirtualMachineScaleSetResponse;

const DEFAULT_IMAGE = {
  publisher: "Canonical",
  offer: "ubuntu-24_04-lts",
  sku: "server",
  version: "latest",
} as const;

const getScaleSet = (subscriptionId: string, resourceGroupName: string, vmScaleSetName: string) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineScaleSet({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
    }),
  );

/** Sorted instance IDs of a Uniform scale set; `[]` for Flexible ones. */
const listInstanceIds = (subscriptionId: string, resourceGroupName: string, set: Observed) =>
  Effect.gen(function* () {
    if (set.properties?.orchestrationMode !== "Uniform" || set.name === undefined) return [];
    const page = yield* collectAll(compute.ListVirtualMachineScaleSetVMs, {
      subscriptionId,
      resourceGroupName,
      virtualMachineScaleSetName: set.name,
    });
    return page.value
      .flatMap((vm) => (vm.instanceId === undefined ? [] : [vm.instanceId]))
      .sort((a, b) => Number(a) - Number(b));
  });

const toAttrs = (
  resourceGroup: string,
  name: string,
  set: Observed,
  instanceIds: string[],
): VirtualMachineScaleSet["Attributes"] => ({
  virtualMachineScaleSetName: name,
  virtualMachineScaleSetId: set.id ?? "",
  uniqueId: set.properties?.uniqueId,
  resourceGroup,
  location: set.location,
  zones: [...(set.zones ?? [])],
  orchestrationMode: set.properties?.orchestrationMode,
  vmSize: set.sku?.name,
  capacity: set.sku?.capacity,
  instanceIds,
  principalId: set.identity?.principalId,
  timeCreated: set.properties?.timeCreated,
  tags: userTags(set.tags),
});

const identityInput = (
  identity: VirtualMachineIdentity | undefined,
): compute.VirtualMachineScaleSetIdentityInput | undefined => {
  if (identity === undefined) return undefined;
  const system = identity.systemAssigned ?? false;
  const users = identity.userAssignedIdentityIds ?? [];
  return {
    type:
      system && users.length > 0
        ? "SystemAssigned, UserAssigned"
        : system
          ? "SystemAssigned"
          : users.length > 0
            ? "UserAssigned"
            : "None",
    userAssignedIdentities:
      users.length > 0 ? Object.fromEntries(users.map((userId) => [userId, {}])) : undefined,
  };
};

const identityKey = (type: string | undefined, userIds: ReadonlyArray<string>) =>
  canonical({
    system: (type ?? "None").includes("SystemAssigned"),
    users: userIds.map((id) => id.toLowerCase()).sort(),
  });

const imageReference = (image: VirtualMachineImage | undefined): compute.ImageReferenceInput => {
  const value = image ?? DEFAULT_IMAGE;
  return "id" in value
    ? { id: value.id }
    : {
        publisher: value.publisher,
        offer: value.offer,
        sku: value.sku,
        version: value.version ?? "latest",
      };
};

/** Immutable-after-create inputs that Azure does not echo back verbatim. */
const immutableKey = (p: VirtualMachineScaleSetProps) =>
  canonical({
    image: imageReference(p.image),
    osDiskStorageAccountType: p.osDiskStorageAccountType ?? "Standard_LRS",
    subnetId: p.subnetId.toLowerCase(),
    networkSecurityGroupId: p.networkSecurityGroupId?.toLowerCase(),
    pools: (p.loadBalancerBackendAddressPoolIds ?? []).map((id) => id.toLowerCase()).sort(),
    adminUsername: p.adminUsername,
    sshPublicKeys: p.sshPublicKeys ?? [],
    computerNamePrefix: p.computerNamePrefix,
    customData: p.customData,
    priority: p.priority ?? "Regular",
    evictionPolicy: p.evictionPolicy,
    platformFaultDomainCount: p.platformFaultDomainCount ?? 1,
    proximityPlacementGroupId: p.proximityPlacementGroupId?.toLowerCase(),
    hasPassword: p.adminPassword !== undefined,
  });

export const VirtualMachineScaleSetProvider = () =>
  Provider.succeed(VirtualMachineScaleSet, {
    stables: [
      "virtualMachineScaleSetName",
      "virtualMachineScaleSetId",
      "uniqueId",
      "resourceGroup",
      "location",
      "timeCreated",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(compute.ListVirtualMachineScaleSetAll, { subscriptionId });
      return page.value.flatMap((set) => {
        const resourceGroup = resourceGroupOf(set.id);
        return hasAnyAlchemyTag(set.tags) && resourceGroup !== undefined && set.name !== undefined
          ? [toAttrs(resourceGroup, set.name, set, [])]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.virtualMachineScaleSetName)) ||
        (news.location !== undefined && !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameId(news.orchestrationMode ?? "Flexible", output.orchestrationMode ?? "Flexible") ||
        (olds !== undefined && immutableKey(news) !== immutableKey(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.virtualMachineScaleSetName ?? olds?.name ?? (yield* createComputeName(id, 64));
      const observed = yield* getScaleSet(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const instanceIds = yield* listInstanceIds(subscriptionId, resourceGroup, observed);
      const attrs = toAttrs(resourceGroup, name, observed, instanceIds);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.virtualMachineScaleSetName ?? (yield* createComputeName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const capacity = news.capacity ?? 1;
      const flexible = (news.orchestrationMode ?? "Flexible") === "Flexible";
      const upgradeMode = news.upgradePolicyMode ?? "Manual";
      const bootDiagnostics = news.bootDiagnostics ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: name,
      };
      const label = `virtual machine scale set ${name}`;
      const get = getScaleSet(subscriptionId, resourceGroup, name);
      // A scale set always reports a provisioning state; one seen without it
      // right after the create PUT is still being set up (a deploy once
      // returned after 1.7s while the scale set was still `Creating`).
      const wait = waitForProvisioned(
        label,
        get,
        (set) => set.properties?.provisioningState ?? "Creating",
        { interval: "5 seconds", times: 150 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const sshKeys = news.sshPublicKeys ?? [];
        yield* compute
          .VirtualMachineScaleSetsCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            sku: { name: news.vmSize, capacity },
            identity: identityInput(news.identity),
            properties: {
              orchestrationMode: news.orchestrationMode ?? "Flexible",
              platformFaultDomainCount: news.platformFaultDomainCount ?? 1,
              singlePlacementGroup: flexible ? undefined : false,
              overprovision: flexible ? undefined : false,
              upgradePolicy: { mode: upgradeMode },
              proximityPlacementGroup: ref(news.proximityPlacementGroupId),
              virtualMachineProfile: {
                osProfile: {
                  computerNamePrefix:
                    news.computerNamePrefix ?? name.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 9),
                  adminUsername: news.adminUsername,
                  adminPassword: news.adminPassword,
                  customData: news.customData,
                  linuxConfiguration:
                    sshKeys.length > 0
                      ? {
                          disablePasswordAuthentication: news.adminPassword === undefined,
                          ssh: {
                            publicKeys: sshKeys.map((keyData) => ({
                              path: `/home/${news.adminUsername}/.ssh/authorized_keys`,
                              keyData,
                            })),
                          },
                        }
                      : undefined,
                },
                storageProfile: {
                  imageReference: imageReference(news.image),
                  osDisk: {
                    createOption: "FromImage",
                    deleteOption: flexible ? "Delete" : undefined,
                    managedDisk: {
                      storageAccountType: news.osDiskStorageAccountType ?? "Standard_LRS",
                    },
                  },
                },
                networkProfile: {
                  networkApiVersion: flexible ? "2020-11-01" : undefined,
                  networkInterfaceConfigurations: [
                    {
                      name: "nic",
                      properties: {
                        primary: true,
                        deleteOption: flexible ? "Delete" : undefined,
                        networkSecurityGroup: ref(news.networkSecurityGroupId),
                        ipConfigurations: [
                          {
                            name: "ipconfig",
                            properties: {
                              primary: true,
                              subnet: { id: news.subnetId },
                              loadBalancerBackendAddressPools:
                                news.loadBalancerBackendAddressPoolIds?.map((poolId) => ({
                                  id: poolId,
                                })),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                diagnosticsProfile: {
                  bootDiagnostics: { enabled: bootDiagnostics },
                },
                priority: news.priority,
                evictionPolicy: news.evictionPolicy,
              },
            },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* wait;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const skuChanged = observed.sku?.name !== news.vmSize || observed.sku?.capacity !== capacity;
      const properties: compute.VirtualMachineScaleSetUpdatePropertiesInput = {};
      if (!sameId(observed.properties?.upgradePolicy?.mode, upgradeMode)) {
        properties.upgradePolicy = { mode: upgradeMode };
      }
      if (
        (observed.properties?.virtualMachineProfile?.diagnosticsProfile?.bootDiagnostics?.enabled ??
          false) !== bootDiagnostics
      ) {
        properties.virtualMachineProfile = {
          diagnosticsProfile: { bootDiagnostics: { enabled: bootDiagnostics } },
        };
      }
      const desiredIdentity = identityInput(news.identity);
      const identityChanged =
        desiredIdentity !== undefined &&
        identityKey(
          observed.identity?.type,
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ) !== identityKey(desiredIdentity.type, news.identity?.userAssignedIdentityIds ?? []);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || Object.keys(properties).length > 0 || identityChanged || tagsChanged) {
        yield* compute
          .UpdateVirtualMachineScaleSet({
            ...where,
            sku: skuChanged ? { name: news.vmSize, capacity } : undefined,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? desiredIdentity : undefined,
            properties: Object.keys(properties).length > 0 ? properties : undefined,
          })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* wait;
      }

      const instanceIds = yield* listInstanceIds(subscriptionId, resourceGroup, observed);
      return toAttrs(resourceGroup, name, observed, instanceIds);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachineScaleSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmScaleSetName: output.virtualMachineScaleSetName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `virtual machine scale set ${output.virtualMachineScaleSetName}`,
        getScaleSet(subscriptionId, output.resourceGroup, output.virtualMachineScaleSetName),
        { interval: "5 seconds", times: 150 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Compute.ProximityPlacementGroup"],
    },
  });
