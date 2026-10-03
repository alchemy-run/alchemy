import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface DdosProtectionPlanProps {
  /** Resource group of the plan. Changing it replaces the plan. */
  resourceGroup: string;
  /**
   * Name of the plan: 1-80 letters, digits, `_`, `.`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the plan.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the plan.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DdosProtectionPlan extends Resource<
  "Azure.Network.DdosProtectionPlan",
  DdosProtectionPlanProps,
  {
    /** Name of the plan. */
    ddosProtectionPlanName: string;
    /** ARM resource ID of the plan. */
    ddosProtectionPlanId: string;
    /** Resource group of the plan. */
    resourceGroup: string;
    /** Location of the plan. */
    location: string;
    /** IDs of the virtual networks protected by the plan. */
    virtualNetworkIds: string[];
    /** IDs of the public IP addresses protected by the plan. */
    publicIpAddressIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DDoS Network Protection plan — enhanced DDoS mitigation for the
 * public IPs of every virtual network that references the plan (through
 * the VNet's `ddosProtectionPlanId`), across subscriptions in the tenant.
 * A plan bills ≈ $2,944/month (covering 100 public IPs) from creation.
 *
 * @see https://learn.microsoft.com/azure/ddos-protection/ddos-protection-overview
 *
 * ### Creating a Plan
 * **Example:** One plan for the tenant's virtual networks
 * ```typescript
 * const plan = yield* Azure.Network.DdosProtectionPlan("ddos", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * @resource
 */
export const DdosProtectionPlan = Resource<DdosProtectionPlan>(
  "Azure.Network.DdosProtectionPlan",
);

export const DdosProtectionPlanProvider = () =>
  Provider.succeed(
    DdosProtectionPlan,
    networkProvider<DdosProtectionPlan>()({
      label: "DDoS protection plan",
      nameAttr: "ddosProtectionPlanName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetDdosProtectionPlan({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            ddosProtectionPlanName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.DdosProtectionPlansCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ddosProtectionPlanName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteDdosProtectionPlan({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ddosProtectionPlanName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateDdosProtectionPlanTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ddosProtectionPlanName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListDdosProtectionPlans({ subscriptionId }),
      body: (_news, { location, tags }) => ({ location, tags }),
      drifted: () => false,
      toAttrs: (path, observed) => ({
        ddosProtectionPlanName: path.name,
        ddosProtectionPlanId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualNetworkIds: idsOf(observed.properties?.virtualNetworks),
        publicIpAddressIds: idsOf(observed.properties?.publicIPAddresses),
        tags: userTags(observed.tags),
      }),
    }),
  );
