import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  labLocation,
} from "./Common.ts";

export interface ServiceFabricProps {
  /** Resource group of the lab. Changing it replaces the registration. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the registration. */
  lab: string;
  /** Name of the lab user that owns the cluster. Changing it replaces the registration. */
  user: string;
  /**
   * Registration name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the registration.
   */
  name?: string;
  /**
   * ARM ID of the existing `Microsoft.ServiceFabric/clusters` cluster.
   * Changing it replaces the registration.
   */
  externalServiceFabricId: string;
  /**
   * ARM ID of the lab environment the cluster was deployed by, if any.
   * Changing it replaces the registration.
   */
  environmentId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ServiceFabric extends Resource<
  "Azure.DevTestLabs.ServiceFabric",
  ServiceFabricProps,
  {
    /** Name of the registration. */
    serviceFabricName: string;
    /** ARM resource ID of the lab Service Fabric registration. */
    serviceFabricId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Name of the lab user that owns the cluster. */
    user: string;
    /** ARM ID of the registered cluster. */
    externalServiceFabricId: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Registers an existing Service Fabric cluster with a DevTest Labs user so
 * the lab can start, stop, and schedule it.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/create-environment-service-fabric-cluster
 *
 * ### Registering a Cluster
 * **Example:** Lab-managed Service Fabric cluster
 * ```typescript
 * const fabric = yield* Azure.DevTestLabs.ServiceFabric("cluster", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   user: user.userName,
 *   externalServiceFabricId: clusterId,
 * });
 * ```
 *
 * @resource
 */
export const ServiceFabric = Resource<ServiceFabric>(
  "Azure.DevTestLabs.ServiceFabric",
);

const getFabric = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetServiceFabric({
      subscriptionId,
      resourceGroupName,
      labName,
      userName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  user: string,
  name: string,
  f: devtestlabs.GetServiceFabricResponse,
): ServiceFabric["Attributes"] => ({
  serviceFabricName: name,
  serviceFabricId: f.id ?? "",
  resourceGroup,
  lab,
  user,
  externalServiceFabricId: f.properties?.externalServiceFabricId,
  uniqueIdentifier: f.properties?.uniqueIdentifier,
  tags: userTags(f.tags),
});

export const ServiceFabricProvider = () =>
  Provider.succeed(ServiceFabric, {
    stables: [
      "serviceFabricName",
      "serviceFabricId",
      "resourceGroup",
      "lab",
      "user",
    ],

    // Registrations are deleted with their lab user.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.user.toLowerCase() !== output.user.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.serviceFabricName.toLowerCase()) ||
        news.externalServiceFabricId.toLowerCase() !==
          (output.externalServiceFabricId ?? news.externalServiceFabricId).toLowerCase() ||
        news.environmentId?.toLowerCase() !== olds?.environmentId?.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      const user = output?.user ?? olds?.user;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        user === undefined
      ) {
        return undefined;
      }
      const name =
        output?.serviceFabricName ??
        olds?.name ??
        (yield* createLabResourceName(id));
      const observed = yield* getFabric(
        subscriptionId,
        resourceGroup,
        lab,
        user,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, user, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab, user } = news;
      const name =
        news.name ??
        output?.serviceFabricName ??
        (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        labName: lab,
        userName: user,
        name,
      };
      const get = getFabric(subscriptionId, resourceGroup, lab, user, name);
      const wait = waitForProvisioned(
        `lab service fabric ${name}`,
        get,
        (f) => f.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure: the registration is fixed at creation (long-running PUT).
      if (observed === undefined) {
        yield* devtestlabs.ServiceFabricsCreateOrUpdate({
          ...where,
          location: yield* labLocation(subscriptionId, resourceGroup, lab),
          tags,
          properties: {
            externalServiceFabricId: news.externalServiceFabricId,
            environmentId: news.environmentId,
          },
        });
        observed = yield* wait;
      }

      // Sync tags (PATCH updates tags only).
      if (tagsDiffer(observed.tags, tags)) {
        yield* devtestlabs.UpdateServiceFabric({ ...where, tags });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, user, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteServiceFabric({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          userName: output.user,
          name: output.serviceFabricName,
        }),
      );
      yield* waitUntilGone(
        `lab service fabric ${output.serviceFabricName}`,
        getFabric(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.user,
          output.serviceFabricName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
