import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AVS_NAMESPACE,
  CHILD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameName,
  sameSet,
} from "./common.ts";

export interface PlacementPolicyProps {
  /** Resource group of the private cloud. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the policy. */
  privateCloud: string;
  /** Name of the cluster. Changing it replaces the policy. */
  cluster: string;
  /**
   * Name of the placement policy. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * `VmVm` keeps VMs together or apart; `VmHost` pins VMs to (or away from)
   * hosts. Changing it replaces the policy.
   */
  type: "VmVm" | "VmHost";
  /**
   * `Affinity` or `AntiAffinity`. Changing it replaces the policy.
   */
  affinityType: "Affinity" | "AntiAffinity";
  /** vCenter VM resource IDs the policy applies to. */
  vmMembers: string[];
  /** `VmHost` only: host names the VMs are placed on or kept away from. */
  hostMembers?: string[];
  /** `VmHost` only: whether the rule is a preference (`Should`) or a requirement (`Must`). */
  affinityStrength?: "Should" | "Must";
  /** `VmHost` only: Azure Hybrid Benefit opt-in for SQL Server hosts. */
  azureHybridBenefitType?: "SqlHost" | "None";
  /**
   * Whether the policy is enforced.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /** Display name of the policy. Changing it replaces the policy. */
  displayName?: string;
}

export interface PlacementPolicy extends Resource<
  "Azure.VMware.PlacementPolicy",
  PlacementPolicyProps,
  {
    /** Name of the placement policy. */
    placementPolicyName: string;
    /** ARM resource ID of the placement policy. */
    placementPolicyId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Name of the cluster. */
    cluster: string;
    /** Policy type. */
    type: string;
    /** Whether the policy is enforced. */
    state: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A vSphere DRS placement policy (VM-VM or VM-host affinity rule) on an
 * Azure VMware Solution cluster.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/create-placement-policy
 *
 * ### Keeping VMs Apart
 * **Example:** VM-VM anti-affinity
 * ```typescript
 * yield* Azure.VMware.PlacementPolicy("spread", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   cluster: "Cluster-1",
 *   type: "VmVm",
 *   affinityType: "AntiAffinity",
 *   vmMembers: [vm1Id, vm2Id],
 * });
 * ```
 *
 * ### Pinning VMs to Hosts
 * **Example:** VM-host affinity that must be honoured
 * ```typescript
 * yield* Azure.VMware.PlacementPolicy("pin", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   cluster: "Cluster-1",
 *   type: "VmHost",
 *   affinityType: "Affinity",
 *   affinityStrength: "Must",
 *   vmMembers: [vm1Id],
 *   hostMembers: ["esx01.example.avs.azure.com"],
 * });
 * ```
 *
 * @resource
 */
export const PlacementPolicy = Resource<PlacementPolicy>(
  "Azure.VMware.PlacementPolicy",
);

const createName = (id: string) => createAvsName(id, 32);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  clusterName: string,
  placementPolicyName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetPlacementPolicy({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      clusterName,
      placementPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  cluster: string,
  name: string,
  policy: vmware.GetPlacementPolicyResponse,
): PlacementPolicy["Attributes"] => ({
  placementPolicyName: name,
  placementPolicyId: policy.id ?? "",
  resourceGroup,
  privateCloud,
  cluster,
  type: policy.properties?.type ?? "",
  state: policy.properties?.state,
  provisioningState: policy.properties?.provisioningState,
});

export const PlacementPolicyProvider = () =>
  Provider.succeed(PlacementPolicy, {
    stables: [
      "placementPolicyName",
      "placementPolicyId",
      "resourceGroup",
      "privateCloud",
      "cluster",
      "type",
    ],

    // Placement policies live inside a private cloud; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        !sameName(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.placementPolicyName) ||
        news.type !== output.type ||
        (olds !== undefined &&
          (news.affinityType !== olds.affinityType ||
            news.displayName !== olds.displayName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      const cluster = output?.cluster ?? olds?.cluster;
      if (
        resourceGroup === undefined ||
        privateCloud === undefined ||
        cluster === undefined
      ) {
        return undefined;
      }
      const name =
        output?.placementPolicyName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        privateCloud,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        privateCloud,
        cluster,
        name,
        observed,
      );
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud, cluster } = news;
      const name =
        news.name ?? output?.placementPolicyName ?? (yield* createName(id));
      const state = news.state ?? "Enabled";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        clusterName: cluster,
        placementPolicyName: name,
      };
      const get = getPolicy(
        subscriptionId,
        resourceGroup,
        privateCloud,
        cluster,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS placement policy ${name}`,
          get,
          (policy) => policy.properties?.provisioningState,
          CHILD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.PlacementPoliciesCreateOrUpdate({
          ...where,
          properties: {
            type: news.type,
            state,
            displayName: news.displayName,
            affinityType: news.affinityType,
            vmMembers: news.vmMembers,
            hostMembers: news.hostMembers,
            affinityStrength: news.affinityStrength,
            azureHybridBenefitType: news.azureHybridBenefitType,
          },
        });
      }
      observed = yield* wait();

      // Sync the mutable members and settings against observed state.
      const props = observed.properties;
      const changed: vmware.PlacementPolicyUpdateProperties = {};
      if (props?.state !== state) changed.state = state;
      if (!sameSet(props?.vmMembers, news.vmMembers)) {
        changed.vmMembers = news.vmMembers;
      }
      if (
        news.hostMembers !== undefined &&
        !sameSet(props?.hostMembers, news.hostMembers)
      ) {
        changed.hostMembers = news.hostMembers;
      }
      if (
        news.affinityStrength !== undefined &&
        props?.affinityStrength !== news.affinityStrength
      ) {
        changed.affinityStrength = news.affinityStrength;
      }
      if (
        news.azureHybridBenefitType !== undefined &&
        props?.azureHybridBenefitType !== news.azureHybridBenefitType
      ) {
        changed.azureHybridBenefitType = news.azureHybridBenefitType;
      }
      if (Object.keys(changed).length > 0) {
        yield* vmware.UpdatePlacementPolicy({ ...where, properties: changed });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, privateCloud, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeletePlacementPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          clusterName: output.cluster,
          placementPolicyName: output.placementPolicyName,
        }),
      );
      yield* waitUntilGone(
        `AVS placement policy ${output.placementPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.cluster,
          output.placementPolicyName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
