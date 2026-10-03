import * as cs from "@distilled.cloud/azure/containerservice";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  getFleet,
  sameName,
  subsetMatches,
  whileFleetBusy,
} from "./Common.ts";

export interface FleetManagedNamespaceProps {
  /** Resource group of the fleet. Changing it replaces the namespace. */
  resourceGroup: string;
  /** Name of the fleet (it must have a hub). Changing it replaces the namespace. */
  fleet: string;
  /**
   * Kubernetes namespace name: 1-63 lowercase letters, digits, and
   * hyphens. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the namespace.
   */
  name?: string;
  /** Kubernetes labels of the namespace. */
  labels?: Record<string, string>;
  /** Kubernetes annotations of the namespace. */
  annotations?: Record<string, string>;
  /** Default resource quota, as Kubernetes quantities (CPU in milli-CPU form, e.g. `"500m"`). */
  defaultResourceQuota?: cs.ResourceQuota_2;
  /** Default ingress / egress network policy. */
  defaultNetworkPolicy?: cs.NetworkPolicy_2;
  /**
   * Whether an existing namespace of the same name is taken over:
   * `Never`, `IfIdentical`, or `Always`.
   * @default "Never"
   */
  adoptionPolicy?: cs.AdoptionPolicy_2;
  /**
   * Whether deleting the ARM resource deletes the Kubernetes namespace
   * (`Delete`) or leaves it (`Keep`).
   * @default "Delete"
   */
  deletePolicy?: cs.DeletePolicy_2;
  /**
   * How the namespace is placed onto member clusters. When omitted it
   * exists only on the hub.
   */
  propagationPolicy?: cs.PropagationPolicy;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface FleetManagedNamespace extends Resource<
  "Azure.ContainerService.FleetManagedNamespace",
  FleetManagedNamespaceProps,
  {
    /** Kubernetes namespace name. */
    namespaceName: string;
    /** ARM resource ID of the namespace. */
    namespaceId: string;
    /** Name of the fleet. */
    fleet: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** Location of the namespace (the fleet's). */
    location: string;
    /** Azure portal FQDN of the namespace. */
    portalFqdn: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A namespace managed on an Azure Kubernetes Fleet Manager hub and
 * optionally propagated to member clusters, with a default quota and
 * network policy.
 *
 * The fleet must have a hub cluster (`hubProfile`).
 *
 * @see https://learn.microsoft.com/azure/kubernetes-fleet/concepts-fleet-managed-namespace
 *
 * ### Creating Fleet Namespaces
 * **Example:** Namespace placed on every member
 * ```typescript
 * yield* Azure.ContainerService.FleetManagedNamespace("team-a", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   name: "team-a",
 *   labels: { team: "a" },
 *   propagationPolicy: {
 *     type: "Placement",
 *     placementProfile: {
 *       defaultClusterResourcePlacement: { policy: { placementType: "PickAll" } },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const FleetManagedNamespace = Resource<FleetManagedNamespace>(
  "Azure.ContainerService.FleetManagedNamespace",
);

type ObservedNamespace = cs.GetFleetManagedNamespaceResponse;

const createNamespaceName = (id: string) => createChildName(id, 63);

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
  managedNamespaceName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetFleetManagedNamespace({
      subscriptionId,
      resourceGroupName,
      fleetName,
      managedNamespaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  fleet: string,
  name: string,
  namespace: ObservedNamespace,
): FleetManagedNamespace["Attributes"] => ({
  namespaceName: name,
  namespaceId: namespace.id ?? "",
  fleet,
  resourceGroup,
  location: namespace.location,
  portalFqdn: namespace.properties?.portalFqdn,
  tags: userTags(namespace.tags),
});

const desiredProperties = (
  news: FleetManagedNamespaceProps,
): cs.FleetManagedNamespacePropertiesInput => ({
  managedNamespaceProperties: {
    labels: news.labels ?? {},
    annotations: news.annotations ?? {},
    defaultResourceQuota: news.defaultResourceQuota,
    defaultNetworkPolicy: news.defaultNetworkPolicy,
  },
  adoptionPolicy: news.adoptionPolicy ?? "Never",
  deletePolicy: news.deletePolicy ?? "Delete",
  propagationPolicy: news.propagationPolicy,
});

const propertiesMatch = (
  desired: cs.FleetManagedNamespacePropertiesInput,
  observed: ObservedNamespace["properties"],
) => {
  const { managedNamespaceProperties, ...rest } = desired;
  const { labels, annotations, ...namespaceRest } =
    managedNamespaceProperties ?? {};
  const have = observed?.managedNamespaceProperties;
  return (
    subsetMatches(rest, observed) &&
    subsetMatches(namespaceRest, have) &&
    !tagsDiffer(have?.labels, tagRecord(labels)) &&
    !tagsDiffer(have?.annotations, tagRecord(annotations))
  );
};

const stateOf = (namespace: ObservedNamespace) =>
  namespace.properties?.provisioningState;

export const FleetManagedNamespaceProvider = () =>
  Provider.succeed(FleetManagedNamespace, {
    stables: ["namespaceName", "namespaceId", "fleet", "resourceGroup"],

    // Namespaces live inside a fleet; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.fleet, output.fleet) ||
        (news.name !== undefined && news.name !== output.namespaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fleet = output?.fleet ?? olds?.fleet;
      if (resourceGroup === undefined || fleet === undefined) return undefined;
      const name =
        output?.namespaceName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getNamespace(
        subscriptionId,
        resourceGroup,
        fleet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, fleet, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, fleet } = news;
      const name =
        news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const desired = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        fleetName: fleet,
        managedNamespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, fleet, name);
      const waitReady = waitForProvisioned(
        `fleet managed namespace ${fleet}/${name}`,
        get,
        stateOf,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync properties: the PUT is a full upsert.
      if (
        observed === undefined ||
        !propertiesMatch(desired, observed.properties)
      ) {
        // A fleet namespace lives in its fleet's location.
        const location =
          observed?.location ??
          (yield* getFleet(subscriptionId, resourceGroup, fleet))?.location ??
          env.location;
        yield* cs
          .FleetManagedNamespacesCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: desired,
          })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* waitReady;
      }

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* cs
          .UpdateFleetManagedNamespace({ ...where, tags })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, fleet, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteFleetManagedNamespace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            fleetName: output.fleet,
            managedNamespaceName: output.namespaceName,
          })
          .pipe(Effect.retry(whileFleetBusy)),
      );
      yield* waitUntilGone(
        `fleet managed namespace ${output.fleet}/${output.namespaceName}`,
        getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.fleet,
          output.namespaceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
