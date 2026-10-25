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
import { APP_BUDGET, createFabricChildName, driftedFields, matches, sameArm } from "./Common.ts";

export type ServiceKind = "Stateless" | "Stateful";
export type ServiceMoveCost = sf.MoveCost;
export type ServicePackageActivationMode = sf.ServicePackageActivationMode;
export type ServiceCorrelation = sf.ServiceCorrelation;
export type ServiceLoadMetric = sf.ServiceLoadMetric;
export type ServicePlacementPolicy = sf.ServicePlacementPolicy;
export type ServiceScalingPolicy = sf.ScalingPolicy;

export type ServicePartition =
  | {
      /** A single partition. */
      partitionScheme: "Singleton";
    }
  | {
      /** Partitions evenly spread over an Int64 key range. */
      partitionScheme: "UniformInt64Range";
      /** Number of partitions. */
      count: number;
      /** Lower bound of the key range. */
      lowKey: number;
      /** Upper bound of the key range. */
      highKey: number;
    }
  | {
      /** Named partitions. */
      partitionScheme: "Named";
      /** Partition names. */
      names: string[];
    };

export interface ServiceProps {
  /**
   * Resource group of the cluster. Changing it replaces the service.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the service. */
  cluster: string;
  /** Name of the application. Changing it replaces the service. */
  application: string;
  /**
   * Service name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the service.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /** `Stateless` or `Stateful`. Changing it replaces the service. */
  serviceKind: ServiceKind;
  /** Service type name from the service manifest. Changing it replaces the service. */
  serviceTypeName: string;
  /** How the service is partitioned. Changing it replaces the service. */
  partitionDescription: ServicePartition;
  /**
   * Service package activation mode. Changing it replaces the service.
   * @default Azure's default
   */
  servicePackageActivationMode?: ServicePackageActivationMode;
  /**
   * DNS name of the service (needs the cluster's `DnsService` add-on). Changing it replaces the service.
   * @default no DNS name
   */
  serviceDnsName?: string;
  /**
   * Stateless: instances per partition (`-1` = one on every node).
   * @default Azure's default
   */
  instanceCount?: number;
  /**
   * Stateless: minimum instance count.
   * @default Azure's default
   */
  minInstanceCount?: number;
  /**
   * Stateless: minimum instance percentage.
   * @default Azure's default
   */
  minInstancePercentage?: number;
  /**
   * Stateful: target replica set size.
   * @default Azure's default
   */
  targetReplicaSetSize?: number;
  /**
   * Stateful: minimum replica set size.
   * @default Azure's default
   */
  minReplicaSetSize?: number;
  /**
   * Stateful: whether the service persists state on local disk. Changing it replaces the service.
   * @default false
   */
  hasPersistedState?: boolean;
  /**
   * Stateful: replica restart wait duration (ISO 8601, e.g. `PT1M`).
   * @default Azure's default
   */
  replicaRestartWaitDuration?: string;
  /**
   * Stateful: quorum loss wait duration (ISO 8601).
   * @default Azure's default
   */
  quorumLossWaitDuration?: string;
  /**
   * Stateful: standby replica keep duration (ISO 8601).
   * @default Azure's default
   */
  standByReplicaKeepDuration?: string;
  /**
   * Stateful: service placement time limit (ISO 8601).
   * @default Azure's default
   */
  servicePlacementTimeLimit?: string;
  /**
   * Placement constraints, e.g. `NodeType == web`.
   * @default no constraints
   */
  placementConstraints?: string;
  /**
   * Correlations with other services.
   * @default []
   */
  correlationScheme?: ServiceCorrelation[];
  /**
   * Load metrics used to balance the service.
   * @default []
   */
  serviceLoadMetrics?: ServiceLoadMetric[];
  /**
   * Placement policies.
   * @default []
   */
  servicePlacementPolicies?: ServicePlacementPolicy[];
  /**
   * Default move cost (`Zero`, `Low`, `Medium`, `High`).
   * @default Azure's default
   */
  defaultMoveCost?: ServiceMoveCost;
  /**
   * Auto-scaling policies.
   * @default []
   */
  scalingPolicies?: ServiceScalingPolicy[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "Azure.ServiceFabric.Service",
  ServiceProps,
  {
    /** Name of the service. */
    serviceName: string;
    /** ARM resource ID of the service. */
    serviceId: string;
    /** Name of the application. */
    application: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** `Stateless` or `Stateful`. */
    serviceKind: string;
    /** Service type name. */
    serviceTypeName: string;
    /** Location of the service (the cluster's location). */
    location: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A service of a Service Fabric application on a managed cluster
 * (`Microsoft.ServiceFabric/managedClusters/applications/services`): a
 * running instance of a service type that the application's manifest
 * declares. See the
 * [Azure docs](https://learn.microsoft.com/azure/service-fabric/how-to-managed-cluster-app-deployment-template).
 *
 * :::caution
 * `serviceDnsName` needs the cluster's `DnsService` add-on.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `cluster`, `application`, `name`, `serviceKind`,
 * `serviceTypeName`, `partitionDescription`, `servicePackageActivationMode`,
 * `serviceDnsName`, or `hasPersistedState` replaces the service. Alchemy
 * updates instance counts, replica sizes, placement, load metrics, and
 * scaling in place.
 * :::
 *
 * ### Stateless Services
 * **Example:** Front-end service on every node
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
 * const packageSasUrl = yield* Config.string("VOTING_SFPKG_URL");
 * const v1 = yield* Azure.ServiceFabric.ApplicationTypeVersion("voting-v1", {
 *   cluster: cluster.managedClusterName,
 *   applicationType: appType.applicationTypeName,
 *   version: "1.0.0",
 *   appPackageUrl: packageSasUrl,
 * });
 * const app = yield* Azure.ServiceFabric.Application("voting", {
 *   cluster: cluster.managedClusterName,
 *   version: v1.applicationTypeVersionId,
 *   parameters: { VotingWeb_InstanceCount: "-1" },
 * });
 * const web = yield* Azure.ServiceFabric.Service("web", {
 *   cluster: cluster.managedClusterName,
 *   application: app.applicationName,
 *   serviceKind: "Stateless",
 *   serviceTypeName: "VotingWebType",
 *   partitionDescription: { partitionScheme: "Singleton" },
 *   instanceCount: -1,
 * });
 * ```
 *
 * ### Stateful Services
 * **Example:** Partitioned stateful service
 * ```typescript
 * const data = yield* Azure.ServiceFabric.Service("data", {
 *   cluster: cluster.managedClusterName,
 *   application: app.applicationName,
 *   serviceKind: "Stateful",
 *   serviceTypeName: "VotingDataType",
 *   partitionDescription: {
 *     partitionScheme: "UniformInt64Range",
 *     count: 3,
 *     lowKey: 0,
 *     highKey: 25,
 *   },
 *   hasPersistedState: true,
 *   targetReplicaSetSize: 3,
 *   minReplicaSetSize: 2,
 * });
 * ```
 *
 * @resource
 */
export const Service = GroupedResource<Service>("Azure.ServiceFabric.Service");

type ObservedService = sf.GetServiceResponse | sf.ServiceResource;

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
  serviceName: string,
) =>
  orUndefinedIfNotFound(
    sf.GetService({
      subscriptionId,
      resourceGroupName,
      clusterName,
      applicationName,
      serviceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  application: string,
  name: string,
  service: ObservedService,
): Service["Attributes"] => ({
  serviceName: name,
  serviceId: service.id ?? "",
  application,
  cluster,
  resourceGroup,
  serviceKind: service.properties?.serviceKind ?? "",
  serviceTypeName: service.properties?.serviceTypeName ?? "",
  location: service.location,
  tags: userTags(service.tags),
});

/** Properties that can change in place (sent with a full PUT). */
const mutableProperties = (news: ServiceProps) => ({
  instanceCount: news.instanceCount,
  minInstanceCount: news.minInstanceCount,
  minInstancePercentage: news.minInstancePercentage,
  targetReplicaSetSize: news.targetReplicaSetSize,
  minReplicaSetSize: news.minReplicaSetSize,
  replicaRestartWaitDuration: news.replicaRestartWaitDuration,
  quorumLossWaitDuration: news.quorumLossWaitDuration,
  standByReplicaKeepDuration: news.standByReplicaKeepDuration,
  servicePlacementTimeLimit: news.servicePlacementTimeLimit,
  placementConstraints: news.placementConstraints,
  correlationScheme: news.correlationScheme,
  serviceLoadMetrics: news.serviceLoadMetrics,
  servicePlacementPolicies: news.servicePlacementPolicies,
  defaultMoveCost: news.defaultMoveCost,
  scalingPolicies: news.scalingPolicies,
});

/** Properties fixed at creation (compared in `diff` against the old props). */
const immutableProperties = (news: ServiceProps) => ({
  serviceKind: news.serviceKind,
  serviceTypeName: news.serviceTypeName,
  partitionDescription: news.partitionDescription,
  servicePackageActivationMode: news.servicePackageActivationMode,
  serviceDnsName: news.serviceDnsName,
  hasPersistedState: news.hasPersistedState,
});

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: [
      "serviceName",
      "serviceId",
      "application",
      "cluster",
      "resourceGroup",
      "serviceKind",
      "serviceTypeName",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusters = yield* collectAll(sf.ListManagedClusterBySubscription, { subscriptionId });
      const found: Service["Attributes"][] = [];
      for (const cluster of clusters.value ?? []) {
        const group = resourceGroupOf(cluster.id);
        if (group === undefined || cluster.name === undefined) continue;
        const apps = yield* orUndefinedIfNotFound(
          collectAll(sf.ListApplications, {
            subscriptionId,
            resourceGroupName: group,
            clusterName: cluster.name,
          }),
        );
        for (const app of apps?.value ?? []) {
          if (app.name === undefined) continue;
          const page = yield* orUndefinedIfNotFound(
            collectAll(sf.ListServiceByApplications, {
              subscriptionId,
              resourceGroupName: group,
              clusterName: cluster.name,
              applicationName: app.name,
            }),
          );
          for (const service of page?.value ?? []) {
            if (hasAnyAlchemyTag(service.tags) && service.name !== undefined) {
              found.push(toAttrs(group, cluster.name, app.name, service.name, service));
            }
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.cluster, output.cluster) ||
        !sameArm(news.application, output.application) ||
        (news.name !== undefined && news.name !== output.serviceName) ||
        news.serviceKind !== output.serviceKind ||
        news.serviceTypeName !== output.serviceTypeName
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        !(
          matches(immutableProperties(news), immutableProperties(olds)) &&
          matches(immutableProperties(olds), immutableProperties(news))
        )
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const application = output?.application ?? olds?.application;
      if (resourceGroup === undefined || cluster === undefined || application === undefined) {
        return undefined;
      }
      const name = output?.serviceName ?? olds?.name ?? (yield* createFabricChildName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, cluster, application, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, application, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster, application } = news;
      const name = news.name ?? output?.serviceName ?? (yield* createFabricChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const mutable = mutableProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        applicationName: application,
        serviceName: name,
      };
      const get = getService(subscriptionId, resourceGroup, cluster, application, name);
      const label = `Service Fabric service ${application}/${name}`;
      const inSync = (service: ObservedService) =>
        driftedFields(mutable, service.properties as Record<string, unknown> | undefined).length ===
        0;

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the PUT creates the service and updates its
      // mutable settings (instance counts, placement, metrics).
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
        yield* sf.ServicesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { ...immutableProperties(news), ...mutable },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (service) => (inSync(service) ? service.properties?.provisioningState : "Updating"),
        APP_BUDGET,
      );

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* sf.UpdateService({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (service) =>
            tagsDiffer(service.tags, tags) ? "Updating" : service.properties?.provisioningState,
          APP_BUDGET,
        );
      }

      return toAttrs(resourceGroup, cluster, application, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sf.DeleteService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationName: output.application,
          serviceName: output.serviceName,
        }),
      );
      yield* waitUntilGone(
        `Service Fabric service ${output.application}/${output.serviceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.application,
          output.serviceName,
        ),
        APP_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ServiceFabric.ManagedCluster",
        "Azure.ServiceFabric.Application",
      ],
    },
  });
