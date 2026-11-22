import * as mission from "@distilled.cloud/azure/mission";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  changedProperties,
  createMissionName,
  getCommunity,
  getVirtualEnclave,
  identityDiffers,
  lastSegment,
  NAMESPACE,
  sameName,
  SLOW,
  toIdentity,
} from "./Common.ts";
import type {
  VirtualEnclaveApprovalSettings,
  VirtualEnclavesGovernedService,
  VirtualEnclavesIdentityType,
  VirtualEnclavesMaintenanceMode,
  VirtualEnclavesMonitoringSettings,
  VirtualEnclavesRoleAssignment,
} from "./Types.ts";

/** A subnet carved out of the enclave virtual network. */
export interface EnclaveSubnetConfiguration {
  /** Subnet name. */
  subnetName: string;
  /** Prefix length of the subnet, e.g. `26` for a /26. */
  networkPrefixSize: number;
  /**
   * Service delegation of the subnet, e.g. `"Microsoft.Web/serverFarms"`.
   * @default not set
   */
  subnetDelegation?: string;
}

/** The enclave's spoke virtual network. */
export interface EnclaveVirtualNetwork {
  /**
   * Size of the enclave network, e.g. `"small"`, `"medium"`, `"large"`.
   * Changing it replaces the enclave.
   * @default not set
   */
  networkSize?: string;
  /**
   * Custom CIDR range of the enclave network. Changing it replaces the enclave.
   * @default not set
   */
  customCidrRange?: string;
  /**
   * Subnets of the enclave network.
   * @default not set
   */
  subnetConfigurations?: EnclaveSubnetConfiguration[];
  /**
   * Whether subnets of the enclave may talk to each other.
   * @default not set
   */
  allowSubnetCommunication?: boolean;
}

export interface VirtualEnclaveProps {
  /**
   * Resource group the enclave is created in. Changing it replaces the enclave.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Enclave name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the enclave.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the enclave. Changing it replaces the enclave.
   * @default the community's location
   */
  location?: string;
  /** ARM ID of the governing community. Changing it replaces the enclave. */
  communityId: string;
  /** The enclave's spoke virtual network. */
  enclaveVirtualNetwork: EnclaveVirtualNetwork;
  /**
   * Deploy Azure Bastion into the enclave.
   * @default not set
   */
  bastionEnabled?: boolean;
  /**
   * Whether workload resources are visible to enclave users.
   * @default not set
   */
  workloadResourceVisibility?: "Enabled" | "Disabled";
  /**
   * Whether enclave role assignments are inherited by workloads.
   * @default not set
   */
  rbacInheritance?: "Enabled" | "Disabled";
  /**
   * RBAC role assignments on the enclave.
   * @default not set
   */
  enclaveRoleAssignments?: VirtualEnclavesRoleAssignment[];
  /**
   * RBAC role assignments on the enclave's workloads.
   * @default not set
   */
  workloadRoleAssignments?: VirtualEnclavesRoleAssignment[];
  /**
   * Per-service governance (allow/deny and policy enforcement).
   * @default not set
   */
  governedServiceList?: VirtualEnclavesGovernedService[];
  /**
   * Where enclave diagnostics are sent: `CommunityOnly`, `EnclaveOnly` or `Both`.
   * @default not set
   */
  diagnosticDestination?: "CommunityOnly" | "EnclaveOnly" | "Both";
  /**
   * Maintenance mode of the enclave.
   * @default not set
   */
  maintenanceModeConfiguration?: VirtualEnclavesMaintenanceMode;
  /**
   * ARM ID of a dedicated hub of the community to attach to. Changing it
   * replaces the enclave.
   * @default not set
   */
  dedicatedHubId?: string;
  /**
   * Approval requirements for change requests on the enclave.
   * @default not set
   */
  approvalSettings?: VirtualEnclaveApprovalSettings;
  /**
   * Diagnostic and flow-log destinations.
   * @default not set
   */
  monitoringSettings?: VirtualEnclavesMonitoringSettings;
  /**
   * Managed identity type of the enclave.
   * @default not set
   */
  identityType?: VirtualEnclavesIdentityType;
  /**
   * User-assigned identity resource IDs (with a `UserAssigned` identity type).
   * @default not set
   */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface VirtualEnclave extends Resource<
  "Azure.VirtualEnclaves.VirtualEnclave",
  VirtualEnclaveProps,
  {
    /** Name of the enclave. */
    virtualEnclaveName: string;
    /** ARM resource ID of the enclave. */
    virtualEnclaveId: string;
    /** Resource group that holds the enclave. */
    resourceGroup: string;
    /** Location of the enclave. */
    location: string;
    /** ARM ID of the governing community. */
    communityId: string;
    /** Managed resource group holding the enclave's network and defaults. */
    managedResourceGroupName: string | undefined;
    /** ARM IDs of the resources the enclave manages (VNet, Key Vault, ...). */
    resourceCollection: string[];
    /** Address space allocated to the enclave. */
    enclaveAddressSpace: string | undefined;
    /** Address space of the enclave's managed resources. */
    managedAddressSpace: string | undefined;
    /** Subnets of the enclave network with their resolved IDs and prefixes. */
    subnets: {
      /** Name of the subnet. */
      subnetName: string;
      /** ARM ID of the subnet. */
      subnetResourceId: string | undefined;
      /** Address prefix of the subnet (CIDR). */
      addressPrefix: string | undefined;
    }[];
    /** Last provisioning state. */
    provisioningState: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual Enclave (`Microsoft.Mission/virtualEnclaves`) — a
 * governed spoke virtual network and managed resource group attached to a
 * {@link Community}. Workloads, enclave endpoints and enclave connections
 * live inside it.
 *
 * Provisioning takes 20-40+ minutes. The first enclave of a community
 * deploys the community's virtual hub; create further enclaves after it
 * (make them depend on its `virtualEnclaveId`), because enclaves created
 * concurrently with it end in provisioning state `Failed`.
 *
 * :::caution
 * Changing `name`, `location`, `communityId`, `dedicatedHubId`,
 * `enclaveVirtualNetwork.networkSize`,
 * `enclaveVirtualNetwork.customCidrRange`, or `resourceGroup` replaces the
 * enclave. A new enclave takes 20-40+ minutes to provision.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating a Virtual Enclave
 * **Example:** Small enclave with one subnet
 * ```typescript
 * const community = yield* Azure.VirtualEnclaves.Community("hub", {
 *   addressSpace: "10.0.0.0/16",
 *   firewallSku: "Basic",
 * });
 * const enclave = yield* Azure.VirtualEnclaves.VirtualEnclave("spoke", {
 *   communityId: community.communityId,
 *   enclaveVirtualNetwork: {
 *     networkSize: "small",
 *     subnetConfigurations: [{ subnetName: "apps", networkPrefixSize: 26 }],
 *   },
 * });
 * ```
 *
 * ### Governance
 * **Example:** Enclave with Bastion and role assignments
 * ```typescript
 * const enclave = yield* Azure.VirtualEnclaves.VirtualEnclave("spoke", {
 *   communityId: community.communityId,
 *   enclaveVirtualNetwork: { networkSize: "small" },
 *   bastionEnabled: true,
 *   enclaveRoleAssignments: [
 *     {
 *       roleDefinitionId: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
 *       principals: [{ id: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f", type: "Group" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const VirtualEnclave = GroupedResource<VirtualEnclave>(
  "Azure.VirtualEnclaves.VirtualEnclave",
);

type ObservedEnclave = mission.GetVirtualEnclaveResponse | mission.EnclaveResource;

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedEnclave,
): VirtualEnclave["Attributes"] => ({
  virtualEnclaveName: name,
  virtualEnclaveId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  communityId: observed.properties?.communityResourceId ?? "",
  managedResourceGroupName: observed.properties?.managedResourceGroupName,
  resourceCollection: observed.properties?.resourceCollection ?? [],
  enclaveAddressSpace: observed.properties?.enclaveAddressSpaces?.enclaveAddressSpace,
  managedAddressSpace: observed.properties?.enclaveAddressSpaces?.managedAddressSpace,
  subnets: (observed.properties?.enclaveVirtualNetwork.subnetConfigurations ?? []).map(
    (subnet) => ({
      subnetName: subnet.subnetName,
      subnetResourceId: subnet.subnetResourceId,
      addressPrefix: subnet.addressPrefix,
    }),
  ),
  provisioningState: observed.properties?.provisioningState,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

export const VirtualEnclaveProvider = () =>
  Provider.succeed(VirtualEnclave, {
    stables: [
      "virtualEnclaveName",
      "virtualEnclaveId",
      "resourceGroup",
      "location",
      "communityId",
      "managedResourceGroupName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(mission.ListVirtualEnclaveBySubscription, { subscriptionId });
      return page.value.flatMap((enclave) => {
        const group = resourceGroupOf(enclave.id);
        return hasAnyAlchemyTag(enclave.tags) && group !== undefined && enclave.name !== undefined
          ? [toAttrs(group, enclave.name, enclave)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const oldNetwork = olds?.enclaveVirtualNetwork;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.virtualEnclaveName)) ||
        (news.location !== undefined && !sameName(news.location, output.location)) ||
        !sameName(news.communityId, output.communityId) ||
        (olds !== undefined && !sameName(news.dedicatedHubId, olds.dedicatedHubId)) ||
        (oldNetwork !== undefined &&
          (!sameName(news.enclaveVirtualNetwork.networkSize, oldNetwork.networkSize) ||
            news.enclaveVirtualNetwork.customCidrRange !== oldNetwork.customCidrRange))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.virtualEnclaveName ?? olds?.name ?? (yield* createMissionName(id));
      const observed = yield* getVirtualEnclave(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.virtualEnclaveName ?? (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentity(news.identityType, news.userAssignedIdentityIds);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualEnclaveName: name,
      };
      const mutable = {
        enclaveVirtualNetwork: news.enclaveVirtualNetwork,
        bastionEnabled: news.bastionEnabled,
        workloadResourceVisibility: news.workloadResourceVisibility,
        rbacInheritance: news.rbacInheritance,
        enclaveRoleAssignments: news.enclaveRoleAssignments,
        workloadRoleAssignments: news.workloadRoleAssignments,
        governedServiceList: news.governedServiceList,
        enclaveDefaultSettings:
          news.diagnosticDestination === undefined
            ? undefined
            : { diagnosticDestination: news.diagnosticDestination },
        maintenanceModeConfiguration: news.maintenanceModeConfiguration,
        approvalSettings: news.approvalSettings,
        monitoringSettings: news.monitoringSettings,
      };
      const waitReady = waitForProvisioned(
        `virtual enclave ${name}`,
        getVirtualEnclave(subscriptionId, resourceGroup, name),
        (enclave) => enclave.properties?.provisioningState,
        SLOW,
      );

      // Observe.
      let observed = yield* getVirtualEnclave(subscriptionId, resourceGroup, name);

      // Ensure. Creation deploys the spoke network (long-running).
      if (observed === undefined) {
        // Default to the community's location.
        const community = news.location
          ? undefined
          : yield* getCommunity(
              subscriptionId,
              resourceGroupOf(news.communityId) ?? resourceGroup,
              lastSegment(news.communityId) ?? "",
            );
        const location = news.location ?? output?.location ?? community?.location ?? env.location;
        yield* mission.VirtualEnclaveCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            ...mutable,
            communityResourceId: news.communityId,
            dedicatedHubResourceId: news.dedicatedHubId,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable settings, identity and tags; PATCH only the deltas.
      const properties = changedProperties(mutable, observed.properties);
      const identityChanged = identityDiffers(identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || identityChanged || tagsChanged) {
        yield* mission.UpdateVirtualEnclave({
          ...where,
          properties,
          identity: identityChanged ? identity : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mission.DeleteVirtualEnclave({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualEnclaveName: output.virtualEnclaveName,
        }),
      );
      yield* waitUntilGone(
        `virtual enclave ${output.virtualEnclaveName}`,
        getVirtualEnclave(subscriptionId, output.resourceGroup, output.virtualEnclaveName),
        SLOW,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.Community",
        "Azure.VirtualEnclaves.DedicatedHub",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
