import * as mission from "@distilled.cloud/azure/mission";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  changedProperties,
  createMissionName,
  getCommunity,
  identityDiffers,
  NAMESPACE,
  sameName,
  SLOW,
  toIdentity,
} from "./Common.ts";
import type {
  CommunityApprovalSettings,
  VirtualEnclavesGovernedService,
  VirtualEnclavesIdentityType,
  VirtualEnclavesMaintenanceMode,
  VirtualEnclavesMonitoringSettings,
  VirtualEnclavesRoleAssignment,
} from "./Types.ts";

export interface CommunityProps {
  /** Resource group the community is created in. Changing it replaces the community. */
  resourceGroup: string;
  /**
   * Community name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the community.
   */
  name?: string;
  /**
   * Azure location of the community. Changing it replaces the community.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Single CIDR address space of the community hub, e.g. `"10.0.0.0/16"`.
   * Either `addressSpace` or `addressSpaces` is required. Changing it
   * replaces the community.
   */
  addressSpace?: string;
  /**
   * CIDR address spaces of the community hub. Either `addressSpace` or
   * `addressSpaces` is required.
   */
  addressSpaces?: string[];
  /** Custom DNS servers for the community network. */
  dnsServers?: string[];
  /** Per-service governance (allow/deny and policy enforcement). */
  governedServiceList?: VirtualEnclavesGovernedService[];
  /** Whether enclaves may override community policies (`Enclave`) or not (`None`). */
  policyOverride?: "Enclave" | "None";
  /** RBAC role assignments on the community. */
  communityRoleAssignments?: VirtualEnclavesRoleAssignment[];
  /**
   * SKU of the community's Azure Firewall. Azure cannot change the tier of
   * an existing community, so changing it replaces the community. API
   * version 2026-04-01 provisions `Standard` even when `Basic` is
   * requested; the observed tier is reported in the `firewallSku` attribute.
   * @default "Standard"
   */
  firewallSku?: "Basic" | "Standard" | "Premium";
  /** Approval requirements for change requests governed by the community. */
  approvalSettings?: CommunityApprovalSettings;
  /** Maintenance mode of the community. */
  maintenanceModeConfiguration?: VirtualEnclavesMaintenanceMode;
  /** Diagnostic and flow-log destinations. */
  monitoringSettings?: VirtualEnclavesMonitoringSettings;
  /** Managed identity type of the community. */
  identityType?: VirtualEnclavesIdentityType;
  /** User-assigned identity resource IDs (with a `UserAssigned` identity type). */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Community extends Resource<
  "Azure.VirtualEnclaves.Community",
  CommunityProps,
  {
    /** Name of the community. */
    communityName: string;
    /** ARM resource ID of the community; pass it to enclaves and connections. */
    communityId: string;
    /** Resource group that holds the community. */
    resourceGroup: string;
    /** Location of the community. */
    location: string;
    /** Single address space, when set. */
    addressSpace: string | undefined;
    /** Address spaces of the community hub. */
    addressSpaces: string[] | undefined;
    /** Azure Firewall SKU. */
    firewallSku: string | undefined;
    /** Managed resource group holding the community's hub, firewall and logs. */
    managedResourceGroupName: string | undefined;
    /** ARM IDs of the resources the community manages. */
    resourceCollection: string[];
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
 * An Azure Virtual Enclaves community — the governed hub of a mission
 * landing zone. Creating one deploys a managed resource group with a
 * Virtual WAN hub, an Azure Firewall and policy, Log Analytics and Key
 * Vault; virtual enclaves attach to it as spokes.
 *
 * Provisioning takes 30-60+ minutes and the firewall and hub bill hourly.
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating a Community
 * **Example:** Community with a Basic firewall
 * ```typescript
 * const community = yield* Azure.VirtualEnclaves.Community("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   addressSpace: "10.0.0.0/16",
 *   firewallSku: "Basic",
 * });
 * ```
 *
 * ### Governance
 * **Example:** Deny a service and require approval for new enclaves
 * ```typescript
 * const community = yield* Azure.VirtualEnclaves.Community("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   addressSpace: "10.0.0.0/16",
 *   governedServiceList: [
 *     { serviceId: "CosmosDB", option: "Deny", enforcement: "Enabled" },
 *   ],
 *   approvalSettings: {
 *     enclaveCreation: { approvalPolicy: "Required", minimumApproversRequired: 1 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Community = Resource<Community>("Azure.VirtualEnclaves.Community");

type ObservedCommunity =
  | mission.GetCommunityResponse
  | mission.CommunityResource;

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedCommunity,
): Community["Attributes"] => ({
  communityName: name,
  communityId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  addressSpace: observed.properties?.addressSpace,
  addressSpaces: observed.properties?.addressSpaces,
  firewallSku: observed.properties?.firewallSku,
  managedResourceGroupName: observed.properties?.managedResourceGroupName,
  resourceCollection: observed.properties?.resourceCollection ?? [],
  provisioningState: observed.properties?.provisioningState,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

export const CommunityProvider = () =>
  Provider.succeed(Community, {
    stables: [
      "communityName",
      "communityId",
      "resourceGroup",
      "location",
      "managedResourceGroupName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mission
        .ListCommunityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCommunityBySubscription", page),
          ),
        );
      return page.value.flatMap((community) => {
        const group = resourceGroupOf(community.id);
        return hasAnyAlchemyTag(community.tags) &&
          group !== undefined &&
          community.name !== undefined
          ? [toAttrs(group, community.name, community)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.communityName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (news.addressSpace !== undefined &&
          output.addressSpace !== undefined &&
          news.addressSpace !== output.addressSpace) ||
        // Compared against the requested SKU: Azure may provision a
        // different tier than requested (see `firewallSku`).
        (olds !== undefined &&
          !sameName(
            news.firewallSku ?? "Standard",
            olds.firewallSku ?? "Standard",
          ))
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
        output?.communityName ?? olds?.name ?? (yield* createMissionName(id));
      const observed = yield* getCommunity(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.communityName ?? (yield* createMissionName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentity(
        news.identityType,
        news.userAssignedIdentityIds,
      );
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        communityName: name,
      };
      // Mutable settings, compared against observed state.
      const mutable = {
        addressSpaces: news.addressSpaces,
        dnsServers: news.dnsServers,
        governedServiceList: news.governedServiceList,
        policyOverride: news.policyOverride,
        communityRoleAssignments: news.communityRoleAssignments,
        approvalSettings: news.approvalSettings,
        maintenanceModeConfiguration: news.maintenanceModeConfiguration,
        monitoringSettings: news.monitoringSettings,
      };
      const waitReady = waitForProvisioned(
        `virtual enclaves community ${name}`,
        getCommunity(subscriptionId, resourceGroup, name),
        (community) => community.properties?.provisioningState,
        SLOW,
      );

      // Observe.
      let observed = yield* getCommunity(subscriptionId, resourceGroup, name);

      // Ensure. Creation deploys the hub, firewall and logs (long-running).
      if (observed === undefined) {
        yield* mission.CommunityCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            ...mutable,
            addressSpace: news.addressSpace,
            firewallSku: news.firewallSku,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable settings, identity and tags; PATCH only the deltas.
      const properties = changedProperties(mutable, observed.properties);
      const identityChanged = identityDiffers(identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || identityChanged || tagsChanged) {
        yield* mission.UpdateCommunity({
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
        mission.DeleteCommunity({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          communityName: output.communityName,
        }),
      );
      yield* waitUntilGone(
        `virtual enclaves community ${output.communityName}`,
        getCommunity(
          subscriptionId,
          output.resourceGroup,
          output.communityName,
        ),
        SLOW,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
