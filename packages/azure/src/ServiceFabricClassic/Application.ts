import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEntityName, delta, listClusters, lower, matches } from "./Common.ts";

export interface ApplicationProps {
  /**
   * Resource group of the cluster. Changing it replaces the application.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the classic Service Fabric cluster. Changing it replaces the application. */
  cluster: string;
  /**
   * Application name (the application is addressed as `fabric:/<name>`).
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the application.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /** Application type name. Changing it replaces the application. */
  typeName: string;
  /**
   * Registered application type version to run. Changing it starts a
   * rolling application upgrade.
   */
  typeVersion: string;
  /**
   * Application parameters overriding the manifest defaults.
   * @default {} (the manifest defaults)
   */
  parameters?: Record<string, string>;
  /**
   * Policy for application upgrades (rolling mode, health checks).
   * @default Azure's default
   */
  upgradePolicy?: servicefabric.ApplicationUpgradePolicy;
  /**
   * Minimum number of nodes on which capacity is reserved for the application.
   * @default Azure's default
   */
  minimumNodes?: number;
  /**
   * Maximum number of nodes the application's services may be placed on.
   * @default Azure's default
   */
  maximumNodes?: number;
  /**
   * Remove the current application capacity settings.
   * @default Azure's default
   */
  removeApplicationCapacity?: boolean;
  /**
   * Application capacity metrics.
   * @default []
   */
  metrics?: servicefabric.ApplicationMetricDescription[];
  /**
   * User-assigned identities of the application, each mapped to a friendly name used in the manifest.
   * @default []
   */
  managedIdentities?: servicefabric.ApplicationUserAssignedIdentity[];
  /**
   * Managed identity of the application resource.
   * @default no managed identity
   */
  identity?: servicefabric.ManagedIdentityInput;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "Azure.ServiceFabricClassic.Application",
  ApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** ARM resource ID of the application. */
    applicationId: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Application type name. */
    typeName: string | undefined;
    /** Application type version currently running. */
    typeVersion: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Provisioning state of the application. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An application on a classic Service Fabric cluster
 * (`Microsoft.ServiceFabric/clusters/applications`): a running instance of a
 * registered application type version. See the
 * [Azure docs](https://learn.microsoft.com/azure/service-fabric/service-fabric-application-arm-resource).
 *
 * Changing `typeVersion`, `parameters`, or the capacity settings runs a
 * rolling application upgrade under `upgradePolicy`.
 *
 * :::caution
 * The cluster must be `Ready`: its node scale sets are deployed with the
 * `ServiceFabricNode` extension and have joined the cluster.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `cluster`, `name`, or `typeName` replaces the
 * application and its services. Alchemy updates every other prop in place.
 * :::
 *
 * ### Deploying an Application
 * **Example:** Application from a registered version
 * ```typescript
 * const cluster = yield* Azure.ServiceFabricClassic.Cluster("sf", {
 *   reliabilityLevel: "None",
 *   nodeTypes: [
 *     {
 *       name: "nt1",
 *       isPrimary: true,
 *       vmInstanceCount: 1,
 *       clientConnectionEndpointPort: 19000,
 *       httpGatewayEndpointPort: 19080,
 *       applicationPorts: { startPort: 20000, endPort: 30000 },
 *       ephemeralPorts: { startPort: 49152, endPort: 65534 },
 *     },
 *   ],
 * });
 * const appType = yield* Azure.ServiceFabricClassic.ApplicationType("voting-type", {
 *   cluster: cluster.clusterName,
 *   name: "VotingType",
 * });
 * const v1 = yield* Azure.ServiceFabricClassic.ApplicationTypeVersion("voting-v1", {
 *   cluster: cluster.clusterName,
 *   applicationType: appType.applicationTypeName,
 *   version: "1.0.0",
 *   appPackageUrl: "https://<account>.blob.core.windows.net/apps/Voting.sfpkg?<sas>",
 * });
 * const app = yield* Azure.ServiceFabricClassic.Application("voting", {
 *   cluster: cluster.clusterName,
 *   typeName: appType.applicationTypeName,
 *   typeVersion: v1.version,
 *   parameters: { VotingWeb_InstanceCount: "1" },
 * });
 * ```
 *
 * ### Upgrading an Application
 * **Example:** Monitored rolling upgrade
 * ```typescript
 * const app = yield* Azure.ServiceFabricClassic.Application("voting", {
 *   cluster: cluster.clusterName,
 *   typeName: appType.applicationTypeName,
 *   typeVersion: v2.version,
 *   upgradePolicy: {
 *     upgradeMode: "Monitored",
 *     rollingUpgradeMonitoringPolicy: { failureAction: "Rollback" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Application = GroupedResource<Application>("Azure.ServiceFabricClassic.Application");

type Observed = servicefabric.GetApplicationResponse | servicefabric.ApplicationResource;

export const getApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
) =>
  orUndefinedIfNotFound(
    servicefabric.GetApplication({
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
  observed: Observed,
): Application["Attributes"] => ({
  applicationName: name,
  applicationId: observed.id ?? "",
  cluster,
  resourceGroup,
  typeName: observed.properties?.typeName,
  typeVersion: observed.properties?.typeVersion,
  principalId: observed.identity?.principalId,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

/** Properties the PATCH (UpdateApplication) accepts. */
const patchable = (props: ApplicationProps) => ({
  typeVersion: props.typeVersion,
  upgradePolicy: props.upgradePolicy,
  minimumNodes: props.minimumNodes,
  maximumNodes: props.maximumNodes,
  removeApplicationCapacity: props.removeApplicationCapacity,
  metrics: props.metrics,
  managedIdentities: props.managedIdentities,
});

const sameParameters = (
  desired: Record<string, string> | undefined,
  observed: Record<string, string | undefined> | undefined,
) =>
  desired === undefined ||
  (Object.keys(desired).length === Object.keys(observed ?? {}).length &&
    Object.entries(desired).every(([key, value]) => observed?.[key] === value));

const identityKeys = (map: object | undefined) =>
  Object.keys(map ?? {})
    .map((key) => key.toLowerCase())
    .sort();

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: ["applicationName", "applicationId", "cluster", "resourceGroup"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const all: Application["Attributes"][] = [];
      for (const { resourceGroup, clusterName } of yield* listClusters) {
        const page = yield* orUndefinedIfNotFound(
          servicefabric.ListApplications({
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
        (news.name !== undefined && lower(news.name) !== lower(output.applicationName)) ||
        (output.typeName !== undefined && news.typeName !== output.typeName)
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
      const name = output?.applicationName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getApplication(subscriptionId, resourceGroup, cluster, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster } = news;
      const name = news.name ?? output?.applicationName ?? (yield* createEntityName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        applicationName: name,
      };
      const get = getApplication(subscriptionId, resourceGroup, cluster, name);
      // Creation and rolling upgrades run inside the cluster.
      const waitReady = waitForProvisioned(
        `service fabric application ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The identity is only settable through the PUT, so identity
      // drift re-PUTs the full desired state.
      const identityDrifted =
        observed !== undefined &&
        news.identity !== undefined &&
        (!matches(news.identity.type, observed.identity?.type) ||
          !matches(
            identityKeys(news.identity.userAssignedIdentities),
            identityKeys(observed.identity?.userAssignedIdentities),
          ));
      if (observed === undefined || identityDrifted) {
        yield* servicefabric.ApplicationsCreateOrUpdate({
          ...where,
          tags,
          identity: news.identity,
          properties: {
            ...patchable(news),
            typeName: news.typeName,
            parameters: news.parameters,
          },
        });
      }
      observed = yield* waitReady;

      // Sync. PATCH only the observed delta (a rolling upgrade).
      const changed = delta(patchable(news), observed.properties);
      const parametersChanged = !sameParameters(news.parameters, observed.properties?.parameters);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (changed !== undefined || parametersChanged || tagsChanged) {
        yield* servicefabric.UpdateApplication({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: {
            ...changed,
            // An upgrade always names its target version.
            typeVersion: news.typeVersion,
            parameters: parametersChanged ? news.parameters : undefined,
          },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicefabric.DeleteApplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationName: output.applicationName,
        }),
      );
      yield* waitUntilGone(
        `service fabric application ${output.applicationName}`,
        getApplication(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceFabricClassic.ApplicationTypeVersion",
        "Azure.ServiceFabricClassic.Cluster",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
