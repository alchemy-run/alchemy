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
import { listClusters, lower } from "./Common.ts";

export interface ApplicationTypeVersionProps {
  /** Resource group of the cluster. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the classic Service Fabric cluster. Changing it replaces the version. */
  cluster: string;
  /** Name of the application type. Changing it replaces the version. */
  applicationType: string;
  /**
   * Application type version; must equal `ApplicationTypeVersion` in the
   * package's application manifest, e.g. `1.0.0`. Changing it replaces the
   * version.
   */
  version: string;
  /**
   * URL of the `.sfpkg` application package, typically a blob SAS URL the
   * cluster can download. Changing it replaces the version (a registered
   * version is immutable).
   */
  appPackageUrl: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationTypeVersion extends Resource<
  "Azure.ServiceFabricClassic.ApplicationTypeVersion",
  ApplicationTypeVersionProps,
  {
    /** The application type version. */
    version: string;
    /** ARM resource ID of the version. */
    applicationTypeVersionId: string;
    /** Name of the application type. */
    applicationType: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** URL of the registered application package. */
    appPackageUrl: string;
    /** Default application parameters declared by the manifest. */
    defaultParameterList: Record<string, string>;
    /** Provisioning state of the version. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A version of an application type on a classic Service Fabric cluster:
 * registers (provisions) an `.sfpkg` application package with the cluster.
 *
 * The cluster must be `Ready`, and the package URL must be reachable from
 * the cluster (e.g. a blob SAS URL).
 *
 * @see https://learn.microsoft.com/azure/service-fabric/service-fabric-application-arm-resource
 *
 * ### Registering a Package
 * **Example:** Version 1.0.0 from a blob SAS URL
 * ```typescript
 * const v1 = yield* Azure.ServiceFabricClassic.ApplicationTypeVersion("voting-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   applicationType: appType.applicationTypeName,
 *   version: "1.0.0",
 *   appPackageUrl: "https://<account>.blob.core.windows.net/apps/Voting.sfpkg?<sas>",
 * });
 * ```
 *
 * @resource
 */
export const ApplicationTypeVersion = Resource<ApplicationTypeVersion>(
  "Azure.ServiceFabricClassic.ApplicationTypeVersion",
);

type Observed =
  | servicefabric.GetApplicationTypeVersionResponse
  | servicefabric.ApplicationTypeVersionResource;

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
  version: string,
) =>
  orUndefinedIfNotFound(
    servicefabric.GetApplicationTypeVersion({
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
  observed: Observed,
  knownPackageUrl: string | undefined,
): ApplicationTypeVersion["Attributes"] => ({
  version,
  applicationTypeVersionId: observed.id ?? "",
  applicationType,
  cluster,
  resourceGroup,
  // GET omits the (SAS-bearing) package URL, so keep the one we sent.
  appPackageUrl:
    observed.properties?.appPackageUrl || (knownPackageUrl ?? ""),
  defaultParameterList: Object.fromEntries(
    Object.entries(observed.properties?.defaultParameterList ?? {}).flatMap(
      ([key, value]) => (value === undefined ? [] : [[key, value]]),
    ),
  ),
  provisioningState: observed.properties?.provisioningState,
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
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const all: ApplicationTypeVersion["Attributes"][] = [];
      for (const { resourceGroup, clusterName } of yield* listClusters) {
        const types = yield* orUndefinedIfNotFound(
          servicefabric.ListApplicationTypes({
            subscriptionId,
            resourceGroupName: resourceGroup,
            clusterName,
          }),
        );
        for (const type of types?.value ?? []) {
          if (type.name === undefined) continue;
          const versions = yield* orUndefinedIfNotFound(
            servicefabric.ListApplicationTypeVersions({
              subscriptionId,
              resourceGroupName: resourceGroup,
              clusterName,
              applicationTypeName: type.name,
            }),
          );
          for (const item of versions?.value ?? []) {
            if (hasAnyAlchemyTag(item.tags) && item.name !== undefined) {
              all.push(
                toAttrs(
                  resourceGroup,
                  clusterName,
                  type.name,
                  item.name,
                  item,
                  undefined,
                ),
              );
            }
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
        lower(news.applicationType) !== lower(output.applicationType) ||
        news.version !== output.version ||
        news.appPackageUrl !== output.appPackageUrl
      ) {
        return { action: "replace" } as const;
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
        output?.appPackageUrl ?? olds?.appPackageUrl,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster, applicationType, version } = news;
      const tags = yield* desiredTags(id, news.tags);
      const get = getVersion(
        subscriptionId,
        resourceGroup,
        cluster,
        applicationType,
        version,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync tags. The PUT is a long-running operation that
      // downloads and provisions the package in the cluster.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        yield* servicefabric.ApplicationTypeVersionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          applicationTypeName: applicationType,
          version,
          tags,
          properties: { appPackageUrl: news.appPackageUrl },
        });
      }
      observed = yield* waitForProvisioned(
        `service fabric application type version ${applicationType}@${version}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );

      return toAttrs(
        resourceGroup,
        cluster,
        applicationType,
        version,
        observed,
        news.appPackageUrl,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicefabric.DeleteApplicationTypeVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationTypeName: output.applicationType,
          version: output.version,
        }),
      );
      yield* waitUntilGone(
        `service fabric application type version ${output.applicationType}@${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationType,
          output.version,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceFabricClassic.ApplicationType",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
