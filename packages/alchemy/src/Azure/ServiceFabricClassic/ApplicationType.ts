import * as servicefabric from "@distilled.cloud/azure/servicefabric";
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
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, listClusters, lower } from "./Common.ts";

export interface ApplicationTypeProps {
  /** Resource group of the cluster. Changing it replaces the application type. */
  resourceGroup: string;
  /** Name of the classic Service Fabric cluster. Changing it replaces the application type. */
  cluster: string;
  /**
   * Application type name. It must equal `ApplicationTypeName` in the
   * application manifest of the packages registered as versions. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the application type.
   */
  name?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationType extends Resource<
  "Azure.ServiceFabricClassic.ApplicationType",
  ApplicationTypeProps,
  {
    /** Name of the application type. */
    applicationTypeName: string;
    /** ARM resource ID of the application type. */
    applicationTypeId: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Provisioning state of the application type. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An application type on a classic Service Fabric cluster — the named
 * container that application packages are registered under as application
 * type versions.
 *
 * @see https://learn.microsoft.com/azure/service-fabric/service-fabric-application-arm-resource
 *
 * ### Registering an Application Type
 * **Example:** Application type matching the manifest name
 * ```typescript
 * const appType = yield* Azure.ServiceFabricClassic.ApplicationType("voting-type", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   name: "VotingType",
 * });
 * ```
 *
 * @resource
 */
export const ApplicationType = Resource<ApplicationType>(
  "Azure.ServiceFabricClassic.ApplicationType",
);

type Observed =
  | servicefabric.GetApplicationTypeResponse
  | servicefabric.ApplicationTypeResource;

const getApplicationType = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
) =>
  orUndefinedIfNotFound(
    servicefabric.GetApplicationType({
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
  observed: Observed,
): ApplicationType["Attributes"] => ({
  applicationTypeName: name,
  applicationTypeId: observed.id ?? "",
  cluster,
  resourceGroup,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const ApplicationTypeProvider = () =>
  Provider.succeed(ApplicationType, {
    stables: [
      "applicationTypeName",
      "applicationTypeId",
      "cluster",
      "resourceGroup",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const all: ApplicationType["Attributes"][] = [];
      for (const { resourceGroup, clusterName } of yield* listClusters) {
        const page = yield* orUndefinedIfNotFound(
          servicefabric.ListApplicationTypes({
            subscriptionId,
            resourceGroupName: resourceGroup,
            clusterName,
          }),
        );
        for (const item of page?.value ?? []) {
          if (hasAnyAlchemyTag(item.tags) && item.name !== undefined) {
            all.push(toAttrs(resourceGroup, clusterName, item.name, item));
          }
        }
      }
      return all;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.applicationTypeName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) return undefined;
      const name =
        output?.applicationTypeName ??
        olds?.name ??
        (yield* createEntityName(id));
      const observed = yield* getApplicationType(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.applicationTypeName ??
        (yield* createEntityName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getApplicationType(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync tags: the PUT is the only write API.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        yield* servicefabric.ApplicationTypesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          applicationTypeName: name,
          tags,
        });
      }
      observed = yield* waitForProvisioned(
        `service fabric application type ${name}`,
        get,
        (value) => value.properties?.provisioningState,
      );

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicefabric.DeleteApplicationType({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationTypeName: output.applicationTypeName,
        }),
      );
      yield* waitUntilGone(
        `service fabric application type ${output.applicationTypeName}`,
        getApplicationType(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationTypeName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceFabricClassic.Cluster",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
