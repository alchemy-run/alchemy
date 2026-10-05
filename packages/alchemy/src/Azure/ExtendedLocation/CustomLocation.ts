import * as extendedlocation from "@distilled.cloud/azure/extendedlocation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface CustomLocationAuthentication {
  /** Type of the credential, e.g. `KubeConfig`. */
  type: string;
  /** The credential value, e.g. a base64-encoded kubeconfig. */
  value: string;
}

export interface CustomLocationProps {
  /**
   * Resource group the custom location is created in. Changing it replaces
   * the custom location.
   */
  resourceGroup: string;
  /**
   * Name of the custom location, 1-63 lowercase letters, digits and `-`,
   * starting and ending with a letter or digit. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the custom location.
   */
  name?: string;
  /**
   * Azure location of the custom location. It must match the region of the
   * host cluster. Changing it replaces the custom location.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the host cluster — an Arc-connected Kubernetes
   * cluster (`Microsoft.Kubernetes/connectedClusters`) or an AKS cluster.
   * The cluster must be connected and run the custom locations extension.
   * Changing it replaces the custom location.
   */
  hostResourceId: string;
  /**
   * Type of the host the custom location references. Changing it replaces
   * the custom location.
   * @default "Kubernetes"
   */
  hostType?: "Kubernetes";
  /**
   * Kubernetes namespace created on the host cluster for this custom
   * location. Changing it replaces the custom location.
   */
  namespace: string;
  /**
   * ARM resource IDs of the cluster extensions
   * (`Microsoft.KubernetesConfiguration/extensions`) whose resource types
   * the custom location exposes, e.g. the App Service or Data Services
   * extension.
   */
  clusterExtensionIds: string[];
  /** Display name of the custom location. */
  displayName?: string;
  /**
   * Credential the resource provider uses to create the namespace, e.g. a
   * kubeconfig. Azure never returns it, so it is sent on create and
   * whenever it changes.
   */
  authentication?: CustomLocationAuthentication;
  /**
   * Managed identity of the custom location.
   * @default "None"
   */
  identityType?: "SystemAssigned" | "None";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CustomLocation extends Resource<
  "Azure.ExtendedLocation.CustomLocation",
  CustomLocationProps,
  {
    /** Name of the custom location. */
    customLocationName: string;
    /** Resource group that holds the custom location. */
    resourceGroup: string;
    /**
     * ARM resource ID of the custom location. Use it as the
     * `extendedLocation.name` of resources deployed onto the cluster.
     */
    customLocationId: string;
    /** Location of the custom location. */
    location: string;
    /** ARM resource ID of the host cluster. */
    hostResourceId: string;
    /** Type of the host (`Kubernetes`). */
    hostType: string;
    /** Kubernetes namespace on the host cluster. */
    namespace: string;
    /** ARM resource IDs of the enabled cluster extensions. */
    clusterExtensionIds: string[];
    /** Display name of the custom location. */
    displayName: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Managed identity type (`SystemAssigned` or `None`). */
    identityType: string;
    /** Object ID of the system-assigned identity, when enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc custom location — a named target location backed by a
 * namespace on an Arc-enabled Kubernetes cluster. Services such as App
 * Service, Container Apps, Arc data services, and Event Grid deploy onto
 * the cluster by using the custom location as their `extendedLocation`.
 *
 * The host cluster must be connected (its Arc agents running) and have the
 * custom locations feature and the referenced cluster extensions installed.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/platform/conceptual-custom-locations
 *
 * ### Creating a Custom Location
 * **Example:** Custom location over an Arc cluster extension
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge");
 * const location = yield* Azure.ExtendedLocation.CustomLocation("site", {
 *   resourceGroup: group.resourceGroupName,
 *   hostResourceId: cluster.clusterId,
 *   namespace: "appservice-ns",
 *   clusterExtensionIds: [extension.extensionId],
 *   displayName: "Factory floor",
 * });
 * ```
 *
 * ### Identity
 * **Example:** Custom location with a system-assigned identity
 * ```typescript
 * const location = yield* Azure.ExtendedLocation.CustomLocation("site", {
 *   resourceGroup: group.resourceGroupName,
 *   hostResourceId: cluster.clusterId,
 *   namespace: "arc-data",
 *   clusterExtensionIds: [extension.extensionId],
 *   identityType: "SystemAssigned",
 * });
 * ```
 *
 * @resource
 */
export const CustomLocation = Resource<CustomLocation>(
  "Azure.ExtendedLocation.CustomLocation",
);

type ObservedCustomLocation = extendedlocation.GetCustomLocationResponse;

const createCustomLocationName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true, delimiter: "-" });

const getCustomLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    extendedlocation.GetCustomLocation({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const sameIds = (a: readonly string[], b: readonly string[]) => {
  const norm = (ids: readonly string[]) =>
    [...new Set(ids.map((id) => id.toLowerCase()))].sort().join("|");
  return norm(a) === norm(b);
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedCustomLocation,
): CustomLocation["Attributes"] => ({
  customLocationName: name,
  resourceGroup,
  customLocationId: observed.id ?? "",
  location: observed.location,
  hostResourceId: observed.properties?.hostResourceId ?? "",
  hostType: observed.properties?.hostType ?? "Kubernetes",
  namespace: observed.properties?.namespace ?? "",
  clusterExtensionIds: [...(observed.properties?.clusterExtensionIds ?? [])],
  displayName: observed.properties?.displayName,
  provisioningState: observed.properties?.provisioningState,
  identityType: observed.identity?.type ?? "None",
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

export const CustomLocationProvider = () =>
  Provider.succeed(CustomLocation, {
    stables: [
      "customLocationName",
      "resourceGroup",
      "customLocationId",
      "location",
      "hostResourceId",
      "hostType",
      "namespace",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* extendedlocation
        .ListCustomLocationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCustomLocationBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((location) => {
        const group = resourceGroupOf(location.id);
        return hasAnyAlchemyTag(location.tags) &&
          group !== undefined &&
          location.name !== undefined
          ? [toAttrs(group, location.name, location)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.customLocationName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        news.hostResourceId.toLowerCase() !==
          output.hostResourceId.toLowerCase() ||
        (news.hostType ?? "Kubernetes").toLowerCase() !==
          output.hostType.toLowerCase() ||
        news.namespace !== output.namespace
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
        output?.customLocationName ??
        olds?.name ??
        (yield* createCustomLocationName(id));
      const observed = yield* getCustomLocation(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ExtendedLocation");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.customLocationName ??
        (yield* createCustomLocationName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identityType = news.identityType ?? "None";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const waitReady = waitForProvisioned(
        `custom location ${name}`,
        getCustomLocation(subscriptionId, resourceGroup, name),
        (observed) => observed.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* getCustomLocation(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Ensure. The PUT carries the full desired configuration.
      if (observed === undefined) {
        yield* extendedlocation.CustomLocationsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: { type: identityType },
          properties: {
            hostResourceId: news.hostResourceId,
            hostType: news.hostType ?? "Kubernetes",
            namespace: news.namespace,
            clusterExtensionIds: news.clusterExtensionIds,
            displayName: news.displayName,
            authentication: news.authentication,
          },
        });
      }
      observed = yield* waitReady;

      // Sync the mutable aspects against observed state. Authentication is
      // write-only, so `olds` is the only baseline for it.
      const props = observed.properties ?? {};
      const patch: extendedlocation.CustomLocationProperties = {};
      if (
        !sameIds(news.clusterExtensionIds, props.clusterExtensionIds ?? [])
      ) {
        patch.clusterExtensionIds = news.clusterExtensionIds;
      }
      if (
        news.displayName !== undefined &&
        news.displayName !== props.displayName
      ) {
        patch.displayName = news.displayName;
      }
      if (
        news.authentication !== undefined &&
        olds !== undefined &&
        (olds.authentication?.type !== news.authentication.type ||
          olds.authentication?.value !== news.authentication.value)
      ) {
        patch.authentication = news.authentication;
      }
      const propsChanged = Object.keys(patch).length > 0;
      const identityChanged =
        (observed.identity?.type ?? "None") !== identityType;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || identityChanged || tagsChanged) {
        yield* extendedlocation.UpdateCustomLocation({
          ...where,
          properties: propsChanged ? patch : undefined,
          identity: identityChanged ? { type: identityType } : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        extendedlocation.DeleteCustomLocation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.customLocationName,
        }),
      );
      yield* waitUntilGone(
        `custom location ${output.customLocationName}`,
        getCustomLocation(
          subscriptionId,
          output.resourceGroup,
          output.customLocationName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
