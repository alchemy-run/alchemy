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
import {
  APP_BUDGET,
  CLUSTER_BUDGET,
  createFabricChildName,
  driftedFields,
  matches,
  sameArm,
} from "./Common.ts";

export type ApplicationUpgradePolicy = sf.ApplicationUpgradePolicy;

export interface ApplicationManagedIdentity {
  /** Friendly name the application manifest refers to the identity by. */
  name: string;
  /** Principal ID of the user-assigned identity. */
  principalId: string;
}

export interface ApplicationIdentity {
  /** Identity type (`None`, `SystemAssigned`, `UserAssigned`, `SystemAssigned, UserAssigned`). */
  type?: sf.ManagedIdentityType;
  /** ARM IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface ApplicationProps {
  /** Resource group of the cluster. Changing it replaces the application. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the application. */
  cluster: string;
  /**
   * Application name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the application.
   */
  name?: string;
  /**
   * ARM resource ID of the {@link ApplicationTypeVersion} to run. Changing
   * it starts a rolling upgrade of the application.
   */
  version: string;
  /** Overrides of application parameters declared in the manifest. */
  parameters?: Record<string, string>;
  /** Policy for rolling upgrades triggered by version or parameter changes. */
  upgradePolicy?: ApplicationUpgradePolicy;
  /** User-assigned identities, each mapped to a friendly name used by the manifest. */
  managedIdentities?: ApplicationManagedIdentity[];
  /** Managed identities of the application resource. */
  identity?: ApplicationIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "Azure.ServiceFabric.Application",
  ApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** ARM resource ID of the application. */
    applicationId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the running application type version. */
    version: string | undefined;
    /** Location of the application (the cluster's location). */
    location: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An application instance on an Azure Service Fabric managed cluster,
 * created from a registered {@link ApplicationTypeVersion}. Changing
 * `version` or `parameters` performs a rolling upgrade.
 *
 * @see https://learn.microsoft.com/azure/service-fabric/how-to-managed-cluster-app-deployment-template
 *
 * ### Deploying an Application
 * **Example:** Application running version 1.0.0
 * ```typescript
 * const app = yield* Azure.ServiceFabric.Application("voting", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.managedClusterName,
 *   version: v1.applicationTypeVersionId,
 *   parameters: { VotingWeb_InstanceCount: "-1" },
 * });
 * ```
 *
 * ### Upgrading
 * **Example:** Monitored rolling upgrade that rolls back on failure
 * ```typescript
 * const app = yield* Azure.ServiceFabric.Application("voting", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.managedClusterName,
 *   version: v2.applicationTypeVersionId,
 *   upgradePolicy: {
 *     upgradeMode: "Monitored",
 *     rollingUpgradeMonitoringPolicy: {
 *       failureAction: "Rollback",
 *       healthCheckWaitDuration: "00:00:30",
 *       healthCheckStableDuration: "00:01:00",
 *       healthCheckRetryTimeout: "00:05:00",
 *       upgradeTimeout: "01:00:00",
 *       upgradeDomainTimeout: "00:20:00",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Application = Resource<Application>(
  "Azure.ServiceFabric.Application",
);

type ObservedApplication = sf.GetApplicationResponse | sf.ApplicationResource;

const getApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
) =>
  orUndefinedIfNotFound(
    sf.GetApplication({
      subscriptionId,
      resourceGroupName,
      clusterName,
      applicationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  app: ObservedApplication,
): Application["Attributes"] => ({
  applicationName: name,
  applicationId: app.id ?? "",
  cluster,
  resourceGroup,
  version: app.properties?.version,
  location: app.location,
  principalId: app.identity?.principalId,
  tags: userTags(app.tags),
});

const toIdentity = (identity: ApplicationIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

/** Whether the observed identity matches the desired one. */
const identityMatches = (
  desired: ApplicationIdentity | undefined,
  observed: sf.ManagedIdentity | undefined,
) => {
  if (desired === undefined) return true;
  if (!matches(desired.type ?? "None", observed?.type ?? "None")) return false;
  if (desired.userAssignedIdentities === undefined) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = desired.userAssignedIdentities
    .map((id) => id.toLowerCase())
    .sort();
  return matches(want, have);
};

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: [
      "applicationName",
      "applicationId",
      "cluster",
      "resourceGroup",
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
      const found: Application["Attributes"][] = [];
      for (const cluster of clusters.value ?? []) {
        const group = resourceGroupOf(cluster.id);
        if (group === undefined || cluster.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          sf.ListApplications({
            subscriptionId,
            resourceGroupName: group,
            clusterName: cluster.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListApplications", page);
        }
        for (const app of page?.value ?? []) {
          if (hasAnyAlchemyTag(app.tags) && app.name !== undefined) {
            found.push(toAttrs(group, cluster.name, app.name, app));
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
        (news.name !== undefined && news.name !== output.applicationName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.applicationName ??
        olds?.name ??
        (yield* createFabricChildName(id));
      const observed = yield* getApplication(
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
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.applicationName ??
        (yield* createFabricChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties = {
        version: news.version,
        parameters: news.parameters,
        upgradePolicy: news.upgradePolicy,
        managedIdentities: news.managedIdentities,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        applicationName: name,
      };
      const get = getApplication(subscriptionId, resourceGroup, cluster, name);
      const label = `Service Fabric application ${name}`;
      // The upgrade policy is only applied on an upgrade; it is not a
      // drift signal on its own.
      const { upgradePolicy: _, ...compared } = properties;
      const inSync = (app: ObservedApplication) =>
        driftedFields(
          compared,
          app.properties as Record<string, unknown> | undefined,
        ).length === 0 && identityMatches(news.identity, app.identity);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT both creates the application and upgrades
      // it (version, parameters, identities) — send it when missing or
      // drifted.
      if (observed === undefined || !inSync(observed)) {
        const location =
          observed?.location ??
          output?.location ??
          (yield* orUndefinedIfNotFound(
            sf.GetManagedCluster({
              subscriptionId,
              resourceGroupName: resourceGroup,
              clusterName: cluster,
            }),
          ))?.location ??
          env.location;
        yield* sf.ApplicationsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(news.identity),
          properties,
        });
      }
      // Rolling upgrades walk every upgrade domain; allow cluster-scale time.
      observed = yield* waitForProvisioned(
        label,
        get,
        (app) => (inSync(app) ? app.properties?.provisioningState : "Updating"),
        observed === undefined ? APP_BUDGET : CLUSTER_BUDGET,
      );

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* sf.UpdateApplication({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (app) =>
            tagsDiffer(app.tags, tags)
              ? "Updating"
              : app.properties?.provisioningState,
          APP_BUDGET,
        );
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sf.DeleteApplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationName: output.applicationName,
        }),
      );
      yield* waitUntilGone(
        `Service Fabric application ${output.applicationName}`,
        getApplication(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationName,
        ),
        APP_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ServiceFabric.ManagedCluster",
      ],
    },
  });
