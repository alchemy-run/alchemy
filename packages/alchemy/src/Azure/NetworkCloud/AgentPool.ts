import * as nc from "@distilled.cloud/azure/networkcloud";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNexusName,
  customLocation,
  differs,
  NEXUS_NAMESPACE,
  NEXUS_SLOW_BUDGET,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";
import type { NexusAdministratorConfiguration } from "./Types.ts";

export interface AgentPoolProps {
  /**
   * Resource group the agent pool is created in. Changing it replaces the
   * agent pool.
   */
  resourceGroup: string;
  /**
   * Name of the Nexus Kubernetes cluster the agent pool belongs to. Changing it replaces the agent pool.
   */
  kubernetesClusterName: string;
  /**
   * Name of the agent pool. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the agent pool.
   */
  name?: string;
  /**
   * Azure location of the agent pool; must match the location of the Nexus
   * Kubernetes cluster. Changing it replaces the agent pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus Kubernetes cluster's custom location. Changing it replaces the
   * agent pool.
   */
  customLocationId?: string;
  /** Number of nodes in the pool. */
  count: number;
  /** VM SKU of the nodes. Changing it replaces the agent pool. */
  vmSkuName: string;
  /**
   * Pool mode: `System`, `User`, or `NotApplicable`. Changing it replaces
   * the agent pool.
   */
  mode: "System" | "User" | "NotApplicable";
  /** Kubernetes labels of the nodes. Changing them replaces the agent pool. */
  labels?: nc.KubernetesLabel[];
  /** Kubernetes taints of the nodes. Changing them replaces the agent pool. */
  taints?: nc.KubernetesLabel[];
  /** Surge and drain settings for upgrades. */
  upgradeSettings?: nc.AgentPoolUpgradeSettings;
  /**
   * Admin user name and SSH keys of the nodes. The SSH keys are mutable;
   * changing the user name replaces the agent pool.
   */
  administratorConfiguration?: NexusAdministratorConfiguration;
  /** Hugepages and CPU options of the nodes. Changing them replaces the agent pool. */
  agentOptions?: nc.AgentOptions;
  /** Extra networks attached to the nodes. Changing them replaces the agent pool. */
  attachedNetworkConfiguration?: nc.AttachedNetworkConfiguration;
  /** Availability zones of the nodes. Changing them replaces the agent pool. */
  availabilityZones?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AgentPool extends Resource<
  "Azure.NetworkCloud.AgentPool",
  AgentPoolProps,
  {
    /** Name of the agent pool. */
    agentPoolName: string;
    /** ARM resource ID of the agent pool. */
    agentPoolId: string;
    /** Resource group that holds the agent pool. */
    resourceGroup: string;
    /** Name of the parent Nexus Kubernetes cluster. */
    kubernetesClusterName: string;
    /** Location of the agent pool. */
    location: string;
    /** Custom location the agent pool is deployed to. */
    customLocationId: string | undefined;
    /** Number of nodes in the pool. */
    count: number;
    /** VM SKU of the nodes. */
    vmSkuName: string;
    /** Pool mode. */
    mode: string;
    /** Kubernetes version of the pool. */
    kubernetesVersion: string | undefined;
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An agent pool of an Azure Operator Nexus Kubernetes cluster — a group of
 * worker nodes with one VM SKU, labels, and taints. `count`, upgrade
 * settings, and admin SSH keys update in place. Needs a deployed Operator
 * Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-kubernetes-cluster-agent-pools
 *
 * ### Adding an Agent Pool
 * **Example:** User pool with three nodes
 * ```typescript
 * const pool = yield* Azure.NetworkCloud.AgentPool("workers", {
 *   resourceGroup: naks.resourceGroup,
 *   kubernetesClusterName: naks.kubernetesClusterName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   count: 3,
 *   mode: "User",
 *   vmSkuName: "NC_P10_56_v1",
 * });
 * ```
 *
 * @resource
 */
export const AgentPool = Resource<AgentPool>("Azure.NetworkCloud.AgentPool");

type Observed = nc.GetAgentPoolResponse;

const getAgentPool = (
  subscriptionId: string,
  resourceGroupName: string,
  kubernetesClusterName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetAgentPool({
      subscriptionId,
      resourceGroupName,
      kubernetesClusterName,
      agentPoolName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  kubernetesClusterName: string,
  name: string,
  observed: Observed,
): AgentPool["Attributes"] => {
  const p = observed.properties;
  return {
    agentPoolName: name,
    agentPoolId: observed.id ?? "",
    resourceGroup,
    kubernetesClusterName,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    count: p.count,
    vmSkuName: p.vmSkuName,
    mode: p.mode,
    kubernetesVersion: p.kubernetesVersion,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const AgentPoolProvider = () =>
  Provider.succeed(AgentPool, {
    stables: [
      "agentPoolName",
      "agentPoolId",
      "resourceGroup",
      "kubernetesClusterName",
      "location",
      "customLocationId",
    ],

    // Children vanish with their cluster; the parent's list covers them.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.kubernetesClusterName, output.kubernetesClusterName) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.agentPoolName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (news.customLocationId !== undefined &&
          !sameArm(news.customLocationId, output.customLocationId)) ||
        !sameArm(news.vmSkuName, output.vmSkuName) ||
        !sameArm(news.mode, output.mode) ||
        (olds !== undefined &&
          (differs(news.labels, olds.labels) ||
            differs(news.taints, olds.taints) ||
            news.administratorConfiguration?.adminUsername !==
              olds.administratorConfiguration?.adminUsername ||
            differs(news.agentOptions, olds.agentOptions) ||
            differs(
              news.attachedNetworkConfiguration,
              olds.attachedNetworkConfiguration,
            ) ||
            differs(news.availabilityZones, olds.availabilityZones)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const kubernetesClusterName =
        output?.kubernetesClusterName ?? olds?.kubernetesClusterName;
      if (kubernetesClusterName === undefined) return undefined;
      const name =
        output?.agentPoolName ?? olds?.name ?? (yield* createNexusName(id, 63));
      const observed = yield* getAgentPool(
        subscriptionId,
        resourceGroup,
        kubernetesClusterName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        kubernetesClusterName,
        name,
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const kubernetesClusterName = news.kubernetesClusterName;
      const name =
        news.name ?? output?.agentPoolName ?? (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        kubernetesClusterName,
        agentPoolName: name,
      };
      const label = `Nexus agent pool ${name}`;
      const get = getAgentPool(
        subscriptionId,
        resourceGroup,
        kubernetesClusterName,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.AgentPoolsCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation:
            news.customLocationId === undefined
              ? undefined
              : customLocation(news.customLocationId),
          properties: {
            count: news.count,
            vmSkuName: news.vmSkuName,
            mode: news.mode,
            labels: news.labels,
            taints: news.taints,
            upgradeSettings: news.upgradeSettings,
            administratorConfiguration: news.administratorConfiguration,
            agentOptions: news.agentOptions,
            attachedNetworkConfiguration: news.attachedNetworkConfiguration,
            availabilityZones: news.availabilityZones,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const desired: nc.AgentPoolPatchProperties = {
        count: news.count,
        upgradeSettings: news.upgradeSettings,
        administratorConfiguration:
          news.administratorConfiguration?.sshPublicKeys === undefined
            ? undefined
            : { sshPublicKeys: news.administratorConfiguration.sshPublicKeys },
      };
      const delta = propertyDelta(observed.properties, desired);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateAgentPool({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);
      }

      return toAttrs(resourceGroup, kubernetesClusterName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.agentPoolName;
      yield* ignoreNotFound(
        nc.DeleteAgentPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          kubernetesClusterName: output.kubernetesClusterName,
          agentPoolName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus agent pool ${name}`,
        getAgentPool(
          subscriptionId,
          output.resourceGroup,
          output.kubernetesClusterName,
          name,
        ),
        NEXUS_SLOW_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.KubernetesCluster",
      ],
    },
  });
