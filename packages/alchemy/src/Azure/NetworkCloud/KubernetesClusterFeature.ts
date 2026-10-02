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
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";
import type { NexusKeyValuePair } from "./Types.ts";

export interface KubernetesClusterFeatureProps {
  /**
   * Resource group the Kubernetes cluster feature is created in. Changing it replaces the
   * Kubernetes cluster feature.
   */
  resourceGroup: string;
  /**
   * Name of the Nexus Kubernetes cluster the feature belongs to. Changing it replaces the Kubernetes cluster feature.
   */
  kubernetesClusterName: string;
  /**
   * Name of the feature, e.g. `azureMonitorAgent` or `metricsServer`.
   * Changing it replaces the Kubernetes cluster feature.
   */
  name: string;
  /**
   * Azure location of the Kubernetes cluster feature; must match the location of the Nexus
   * Kubernetes cluster. Changing it replaces the Kubernetes cluster feature.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Feature configuration options as key/value pairs. */
  options?: NexusKeyValuePair[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface KubernetesClusterFeature extends Resource<
  "Azure.NetworkCloud.KubernetesClusterFeature",
  KubernetesClusterFeatureProps,
  {
    /** Name of the Kubernetes cluster feature. */
    featureName: string;
    /** ARM resource ID of the Kubernetes cluster feature. */
    featureId: string;
    /** Resource group that holds the Kubernetes cluster feature. */
    resourceGroup: string;
    /** Name of the parent Nexus Kubernetes cluster. */
    kubernetesClusterName: string;
    /** Location of the Kubernetes cluster feature. */
    location: string;
    /** Installed version of the feature. */
    version: string | undefined;
    /** Whether the feature is required by the platform (`True`/`False`). */
    required: string | undefined;
    /** Availability lifecycle, e.g. `GenerallyAvailable` or `Preview`. */
    availabilityLifecycle: string | undefined;
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
 * An optional feature (add-on) of an Azure Operator Nexus Kubernetes
 * cluster, such as the Azure Monitor agent or metrics server, with its
 * configuration options. Platform-required features exist on every cluster
 * and are adopted rather than created. Needs a deployed Operator Nexus
 * cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-kubernetes-cluster-features
 *
 * ### Enabling a Feature
 * **Example:** Azure Monitor agent
 * ```typescript
 * const monitor = yield* Azure.NetworkCloud.KubernetesClusterFeature("monitor", {
 *   resourceGroup: naks.resourceGroup,
 *   kubernetesClusterName: naks.kubernetesClusterName,
 *   name: "azureMonitorAgent",
 *   options: [{ key: "logLevel", value: "info" }],
 * });
 * ```
 *
 * @resource
 */
export const KubernetesClusterFeature = Resource<KubernetesClusterFeature>(
  "Azure.NetworkCloud.KubernetesClusterFeature",
);

type Observed = nc.GetKubernetesClusterFeatureResponse;

const getKubernetesClusterFeature = (
  subscriptionId: string,
  resourceGroupName: string,
  kubernetesClusterName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetKubernetesClusterFeature({
      subscriptionId,
      resourceGroupName,
      kubernetesClusterName,
      featureName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  kubernetesClusterName: string,
  name: string,
  observed: Observed,
): KubernetesClusterFeature["Attributes"] => {
  const p = observed.properties;
  return {
    featureName: name,
    featureId: observed.id ?? "",
    resourceGroup,
    kubernetesClusterName,
    location: observed.location,
    version: p?.version,
    required: p?.required,
    availabilityLifecycle: p?.availabilityLifecycle,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const KubernetesClusterFeatureProvider = () =>
  Provider.succeed(KubernetesClusterFeature, {
    stables: [
      "featureName",
      "featureId",
      "resourceGroup",
      "kubernetesClusterName",
      "location",
    ],

    // Children vanish with their cluster; the parent's list covers them.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.kubernetesClusterName, output.kubernetesClusterName) ||
        !sameArm(news.name, output.featureName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
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
      const name = output?.featureName ?? olds?.name;
      if (name === undefined) return undefined;
      const observed = yield* getKubernetesClusterFeature(
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
      const name = news.name;
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        kubernetesClusterName,
        featureName: name,
      };
      const label = `Nexus Kubernetes cluster feature ${name}`;
      const get = getKubernetesClusterFeature(
        subscriptionId,
        resourceGroup,
        kubernetesClusterName,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.KubernetesClusterFeaturesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { options: news.options },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        options: news.options,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateKubernetesClusterFeature({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, kubernetesClusterName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.featureName;
      yield* ignoreNotFound(
        nc.DeleteKubernetesClusterFeature({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          kubernetesClusterName: output.kubernetesClusterName,
          featureName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus Kubernetes cluster feature ${name}`,
        getKubernetesClusterFeature(
          subscriptionId,
          output.resourceGroup,
          output.kubernetesClusterName,
          name,
        ),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.KubernetesCluster",
      ],
    },
  });
