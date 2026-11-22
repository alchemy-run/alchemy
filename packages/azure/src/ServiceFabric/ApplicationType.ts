import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
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
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { APP_BUDGET, sameArm } from "./Common.ts";

export interface ApplicationTypeProps {
  /**
   * Resource group of the cluster. Changing it replaces the application type.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the application type. */
  cluster: string;
  /**
   * Application type name; must equal the `ApplicationTypeName` in the
   * application manifest of the packages registered under it. Changing it
   * replaces the application type.
   */
  name: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface ApplicationType extends Resource<
  "Azure.ServiceFabric.ApplicationType",
  ApplicationTypeProps,
  {
    /** Name of the application type. */
    applicationTypeName: string;
    /** ARM resource ID of the application type. */
    applicationTypeId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Location of the application type (the cluster's location). */
    location: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An application type registered on an Azure Service Fabric managed cluster
 * (`Microsoft.ServiceFabric/managedClusters/applicationTypes`). Register
 * package versions under it with `Azure.ServiceFabric.ApplicationTypeVersion`
 * and run it with `Azure.ServiceFabric.Application`. See the
 * [Azure docs](https://learn.microsoft.com/azure/service-fabric/how-to-managed-cluster-app-deployment-template).
 *
 * :::caution
 * `name` must equal the `ApplicationTypeName` in the application manifest of
 * every package you register under it.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `cluster`, or `name` replaces the application
 * type. Alchemy updates `tags` in place.
 * :::
 *
 * ### Registering an Application Type
 * **Example:** Application type matching the manifest's type name
 * ```typescript
 * const password = yield* Config.redacted("SF_ADMIN_PASSWORD");
 * const cluster = yield* Azure.ServiceFabric.ManagedCluster("cluster", {
 *   adminUserName: "sfadmin",
 *   adminPassword: password,
 *   clients: [
 *     { isAdmin: true, thumbprint: "0123456789ABCDEF0123456789ABCDEF01234567" },
 *   ],
 * });
 * const primary = yield* Azure.ServiceFabric.NodeType("primary", {
 *   cluster: cluster.managedClusterName,
 *   isPrimary: true,
 *   vmInstanceCount: 3,
 * });
 * const appType = yield* Azure.ServiceFabric.ApplicationType("voting", {
 *   cluster: cluster.managedClusterName,
 *   name: "VotingType",
 * });
 * ```
 *
 * @resource
 */
export const ApplicationType = GroupedResource<ApplicationType>(
  "Azure.ServiceFabric.ApplicationType",
);

type ObservedApplicationType = sf.GetApplicationTypeResponse | sf.ApplicationTypeResource;

const getApplicationType = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
) =>
  orUndefinedIfNotFound(
    sf.GetApplicationType({
      subscriptionId,
      resourceGroupName,
      clusterName,
      applicationTypeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  appType: ObservedApplicationType,
): ApplicationType["Attributes"] => ({
  applicationTypeName: name,
  applicationTypeId: appType.id ?? "",
  cluster,
  resourceGroup,
  location: appType.location,
  tags: userTags(appType.tags),
});

export const ApplicationTypeProvider = () =>
  Provider.succeed(ApplicationType, {
    stables: ["applicationTypeName", "applicationTypeId", "cluster", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusters = yield* collectAll(sf.ListManagedClusterBySubscription, { subscriptionId });
      const found: ApplicationType["Attributes"][] = [];
      for (const cluster of clusters.value ?? []) {
        const group = resourceGroupOf(cluster.id);
        if (group === undefined || cluster.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          collectAll(sf.ListApplicationTypes, {
            subscriptionId,
            resourceGroupName: group,
            clusterName: cluster.name,
          }),
        );
        for (const appType of page?.value ?? []) {
          if (hasAnyAlchemyTag(appType.tags) && appType.name !== undefined) {
            found.push(toAttrs(group, cluster.name, appType.name, appType));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.cluster, output.cluster) ||
        news.name !== output.applicationTypeName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const name = output?.applicationTypeName ?? olds?.name;
      if (resourceGroup === undefined || cluster === undefined || name === undefined) {
        return undefined;
      }
      const observed = yield* getApplicationType(subscriptionId, resourceGroup, cluster, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster, name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        applicationTypeName: name,
      };
      const get = getApplicationType(subscriptionId, resourceGroup, cluster, name);
      const label = `Service Fabric application type ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Child resources live in the cluster's location.
      if (observed === undefined) {
        const location =
          output?.location ??
          (yield* orUndefinedIfNotFound(
            sf.GetManagedCluster({
              subscriptionId,
              resourceGroupName: resourceGroup,
              clusterName: cluster,
            }),
          ))?.location ??
          env.location;
        yield* sf.ApplicationTypesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {},
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (appType) => appType.properties?.provisioningState,
        APP_BUDGET,
      );

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* sf.UpdateApplicationType({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (appType) =>
            tagsDiffer(appType.tags, tags) ? "Updating" : appType.properties?.provisioningState,
          APP_BUDGET,
        );
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sf.DeleteApplicationType({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationTypeName: output.applicationTypeName,
        }),
      );
      yield* waitUntilGone(
        `Service Fabric application type ${output.applicationTypeName}`,
        getApplicationType(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationTypeName,
        ),
        APP_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.ServiceFabric.ManagedCluster"],
    },
  });
