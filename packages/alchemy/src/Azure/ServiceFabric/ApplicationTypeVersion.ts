import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { APP_BUDGET, sameArm } from "./Common.ts";

export interface ApplicationTypeVersionProps {
  /** Resource group of the cluster. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the version. */
  cluster: string;
  /** Name of the application type. Changing it replaces the version. */
  applicationType: string;
  /**
   * Application type version; must equal the `ApplicationTypeVersion` in
   * the package's application manifest. Changing it replaces the version.
   */
  version: string;
  /**
   * URL of the `.sfpkg` application package, typically a blob URL with a
   * read SAS token. Registered packages are immutable: changing the URL
   * replaces the version (deleting the old one first, since the version
   * string is the resource name).
   */
  appPackageUrl: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationTypeVersion extends Resource<
  "Azure.ServiceFabric.ApplicationTypeVersion",
  ApplicationTypeVersionProps,
  {
    /** The application type version. */
    version: string;
    /**
     * ARM resource ID of the version; pass it as an `Application`'s
     * `version`.
     */
    applicationTypeVersionId: string;
    /** Name of the application type. */
    applicationType: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** URL of the registered application package. */
    appPackageUrl: string;
    /** Location of the version (the cluster's location). */
    location: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A version of a Service Fabric application type on a managed cluster:
 * Azure downloads the `.sfpkg` package from `appPackageUrl` and provisions
 * it into the cluster's image store.
 *
 * @see https://learn.microsoft.com/azure/service-fabric/how-to-managed-cluster-app-deployment-template
 *
 * ### Registering a Package Version
 * **Example:** Version from a blob with a SAS token
 * ```typescript
 * const v1 = yield* Azure.ServiceFabric.ApplicationTypeVersion("voting-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.managedClusterName,
 *   applicationType: appType.applicationTypeName,
 *   version: "1.0.0",
 *   appPackageUrl: packageSasUrl,
 * });
 * ```
 *
 * @resource
 */
export const ApplicationTypeVersion = Resource<ApplicationTypeVersion>(
  "Azure.ServiceFabric.ApplicationTypeVersion",
);

type ObservedVersion =
  | sf.GetApplicationTypeVersionResponse
  | sf.ApplicationTypeVersionResource;

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
  version: string,
) =>
  orUndefinedIfNotFound(
    sf.GetApplicationTypeVersion({
      subscriptionId,
      resourceGroupName,
      clusterName,
      applicationTypeName,
      version,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  applicationType: string,
  version: string,
  observed: ObservedVersion,
): ApplicationTypeVersion["Attributes"] => ({
  version,
  applicationTypeVersionId: observed.id ?? "",
  applicationType,
  cluster,
  resourceGroup,
  appPackageUrl: observed.properties?.appPackageUrl ?? "",
  location: observed.location,
  tags: userTags(observed.tags),
});

export const ApplicationTypeVersionProvider = () =>
  Provider.succeed(ApplicationTypeVersion, {
    stables: [
      "version",
      "applicationTypeVersionId",
      "applicationType",
      "cluster",
      "resourceGroup",
      "appPackageUrl",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusters = yield* sf
        .ListManagedClusterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagedClusterBySubscription", page),
          ),
        );
      const found: ApplicationTypeVersion["Attributes"][] = [];
      for (const cluster of clusters.value ?? []) {
        const group = resourceGroupOf(cluster.id);
        if (group === undefined || cluster.name === undefined) continue;
        const types = yield* orUndefinedIfNotFound(
          sf.ListApplicationTypes({
            subscriptionId,
            resourceGroupName: group,
            clusterName: cluster.name,
          }),
        );
        if (types !== undefined) {
          yield* requireSinglePage("ListApplicationTypes", types);
        }
        for (const appType of types?.value ?? []) {
          if (appType.name === undefined) continue;
          const page = yield* orUndefinedIfNotFound(
            sf.ListApplicationTypeVersionByApplicationTypes({
              subscriptionId,
              resourceGroupName: group,
              clusterName: cluster.name,
              applicationTypeName: appType.name,
            }),
          );
          if (page !== undefined) {
            yield* requireSinglePage(
              "ListApplicationTypeVersionByApplicationTypes",
              page,
            );
          }
          for (const version of page?.value ?? []) {
            if (hasAnyAlchemyTag(version.tags) && version.name !== undefined) {
              found.push(
                toAttrs(
                  group,
                  cluster.name,
                  appType.name,
                  version.name,
                  version,
                ),
              );
            }
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameParent =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.cluster, output.cluster) &&
        news.applicationType === output.applicationType;
      if (!sameParent || news.version !== output.version) {
        return { action: "replace" } as const;
      }
      if (news.appPackageUrl !== output.appPackageUrl) {
        // Same parent and version: the name is taken until the old one goes.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const applicationType = output?.applicationType ?? olds?.applicationType;
      const version = output?.version ?? olds?.version;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        applicationType === undefined ||
        version === undefined
      ) {
        return undefined;
      }
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        cluster,
        applicationType,
        version,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        cluster,
        applicationType,
        version,
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster, applicationType, version } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        applicationTypeName: applicationType,
        version,
      };
      const get = getVersion(
        subscriptionId,
        resourceGroup,
        cluster,
        applicationType,
        version,
      );
      const label = `Service Fabric application type version ${applicationType}@${version}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Provisioning downloads and registers the package.
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
        yield* sf.ApplicationTypeVersionsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { appPackageUrl: news.appPackageUrl },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (v) => v.properties?.provisioningState,
        APP_BUDGET,
      );

      // Sync tags (the package is immutable; diff replaces).
      if (tagsDiffer(observed.tags, tags)) {
        yield* sf.UpdateApplicationTypeVersion({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (v) =>
            tagsDiffer(v.tags, tags)
              ? "Updating"
              : v.properties?.provisioningState,
          APP_BUDGET,
        );
      }

      return toAttrs(
        resourceGroup,
        cluster,
        applicationType,
        version,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sf.DeleteApplicationTypeVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationTypeName: output.applicationType,
          version: output.version,
        }),
      );
      yield* waitUntilGone(
        `Service Fabric application type version ${output.applicationType}@${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationType,
          output.version,
        ),
        APP_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ServiceFabric.ManagedCluster",
        "Azure.ServiceFabric.ApplicationType",
      ],
    },
  });
