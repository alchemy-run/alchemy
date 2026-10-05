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
import {
  createEntityName,
  delta,
  listClusters,
  lower,
} from "./Common.ts";

export interface ServiceProps {
  /** Resource group of the cluster. Changing it replaces the service. */
  resourceGroup: string;
  /** Name of the classic Service Fabric cluster. Changing it replaces the service. */
  cluster: string;
  /** Name of the application the service belongs to. Changing it replaces the service. */
  application: string;
  /**
   * Service name within the application (addressed as
   * `fabric:/<application>/<name>`; the ARM resource is named
   * `<application>~<name>`). If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
  /** `Stateless` or `Stateful`. Changing it replaces the service. */
  serviceKind: "Stateless" | "Stateful";
  /** Service type name from the service manifest. Changing it replaces the service. */
  serviceTypeName: string;
  /**
   * Partitioning: `{ partitionScheme: "Singleton" }`,
   * `{ partitionScheme: "UniformInt64Range", count, lowKey, highKey }`, or
   * `{ partitionScheme: "Named", count, names }`. Changing it replaces the
   * service.
   * @default { partitionScheme: "Singleton" }
   */
  partitionDescription?: servicefabric.PartitionSchemeDescription;
  /** `SharedProcess` or `ExclusiveProcess`. Changing it replaces the service. */
  servicePackageActivationMode?: "SharedProcess" | "ExclusiveProcess";
  /** DNS name of the service (requires the DNS add-on). Changing it replaces the service. */
  serviceDnsName?: string;
  /**
   * Stateless: instances per partition (`-1` places one on every node).
   * @default 1 for stateless services
   */
  instanceCount?: number;
  /** Stateless: delay before closing instances during an upgrade (ISO 8601 duration). */
  instanceCloseDelayDuration?: string;
  /** Stateful: target replica set size. */
  targetReplicaSetSize?: number;
  /** Stateful: minimum replica set size. */
  minReplicaSetSize?: number;
  /** Stateful: whether replicas persist state on local disk. Changing it replaces the service. */
  hasPersistedState?: boolean;
  /** Stateful: wait before replacing a down replica (ISO 8601 duration). */
  replicaRestartWaitDuration?: string;
  /** Stateful: maximum time a partition may stay in quorum loss (ISO 8601 duration). */
  quorumLossWaitDuration?: string;
  /** Stateful: how long standby replicas are kept (ISO 8601 duration). */
  standByReplicaKeepDuration?: string;
  /** Placement constraints, e.g. `NodeType == nt1`. */
  placementConstraints?: string;
  /** Correlations with other services. */
  correlationScheme?: servicefabric.ServiceCorrelationDescription[];
  /** Load metrics used for balancing. */
  serviceLoadMetrics?: servicefabric.ServiceLoadMetricDescription[];
  /** Placement policies. */
  servicePlacementPolicies?: servicefabric.ServicePlacementPolicyDescription[];
  /** Default move cost (`Zero`, `Low`, `Medium`, `High`). */
  defaultMoveCost?: servicefabric.MoveCost;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "Azure.ServiceFabricClassic.Service",
  ServiceProps,
  {
    /** ARM name of the service (`<application>~<name>`). */
    serviceName: string;
    /** ARM resource ID of the service. */
    serviceId: string;
    /** Name of the application. */
    application: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** `Stateless` or `Stateful`. */
    serviceKind: string | undefined;
    /** Service type name. */
    serviceTypeName: string | undefined;
    /** Provisioning state of the service. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A service of an application on a classic Service Fabric cluster.
 *
 * Instance and replica counts, placement, load metrics, and move cost
 * change in place; kind, type, partitioning, and DNS name replace the
 * service.
 *
 * @see https://learn.microsoft.com/azure/service-fabric/service-fabric-application-arm-resource
 *
 * ### Creating Services
 * **Example:** Stateless service on every node
 * ```typescript
 * const web = yield* Azure.ServiceFabricClassic.Service("web", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   application: app.applicationName,
 *   name: "VotingWeb",
 *   serviceKind: "Stateless",
 *   serviceTypeName: "VotingWebType",
 *   instanceCount: -1,
 * });
 * ```
 *
 * **Example:** Partitioned stateful service
 * ```typescript
 * const data = yield* Azure.ServiceFabricClassic.Service("data", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   application: app.applicationName,
 *   name: "VotingData",
 *   serviceKind: "Stateful",
 *   serviceTypeName: "VotingDataType",
 *   hasPersistedState: true,
 *   targetReplicaSetSize: 3,
 *   minReplicaSetSize: 2,
 *   partitionDescription: {
 *     partitionScheme: "UniformInt64Range",
 *     count: 5,
 *     lowKey: "0",
 *     highKey: "25",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Service = Resource<Service>("Azure.ServiceFabricClassic.Service");

type Observed =
  | servicefabric.GetServiceResponse
  | servicefabric.ServiceResource;

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
  serviceName: string,
) =>
  orUndefinedIfNotFound(
    servicefabric.GetService({
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
  serviceName: string,
  observed: Observed,
): Service["Attributes"] => ({
  serviceName,
  serviceId: observed.id ?? "",
  application,
  cluster,
  resourceGroup,
  serviceKind: observed.properties?.serviceKind,
  serviceTypeName: observed.properties?.serviceTypeName,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

const armName = (application: string, name: string) =>
  name.includes("~") ? name : `${application}~${name}`;

/** Properties the PATCH (UpdateService) accepts besides `serviceKind`. */
const patchable = (props: ServiceProps) =>
  props.serviceKind === "Stateless"
    ? {
        placementConstraints: props.placementConstraints,
        correlationScheme: props.correlationScheme,
        serviceLoadMetrics: props.serviceLoadMetrics,
        servicePlacementPolicies: props.servicePlacementPolicies,
        defaultMoveCost: props.defaultMoveCost,
        instanceCount: props.instanceCount ?? 1,
        instanceCloseDelayDuration: props.instanceCloseDelayDuration,
      }
    : {
        placementConstraints: props.placementConstraints,
        correlationScheme: props.correlationScheme,
        serviceLoadMetrics: props.serviceLoadMetrics,
        servicePlacementPolicies: props.servicePlacementPolicies,
        defaultMoveCost: props.defaultMoveCost,
        targetReplicaSetSize: props.targetReplicaSetSize,
        minReplicaSetSize: props.minReplicaSetSize,
        replicaRestartWaitDuration: props.replicaRestartWaitDuration,
        quorumLossWaitDuration: props.quorumLossWaitDuration,
        standByReplicaKeepDuration: props.standByReplicaKeepDuration,
      };

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
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const all: Service["Attributes"][] = [];
      for (const { resourceGroup, clusterName } of yield* listClusters) {
        const apps = yield* orUndefinedIfNotFound(
          servicefabric.ListApplications({
            subscriptionId,
            resourceGroupName: resourceGroup,
            clusterName,
          }),
        );
        for (const app of apps?.value ?? []) {
          if (app.name === undefined) continue;
          const services = yield* orUndefinedIfNotFound(
            servicefabric.ListServices({
              subscriptionId,
              resourceGroupName: resourceGroup,
              clusterName,
              applicationName: app.name,
            }),
          );
          for (const item of services?.value ?? []) {
            if (hasAnyAlchemyTag(item.tags) && item.name !== undefined) {
              all.push(
                toAttrs(resourceGroup, clusterName, app.name, item.name, item),
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
        lower(news.application) !== lower(output.application) ||
        (news.name !== undefined &&
          lower(armName(news.application, news.name)) !==
            lower(output.serviceName)) ||
        (output.serviceKind !== undefined &&
          lower(news.serviceKind) !== lower(output.serviceKind)) ||
        (output.serviceTypeName !== undefined &&
          news.serviceTypeName !== output.serviceTypeName)
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
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        application === undefined
      ) {
        return undefined;
      }
      const serviceName =
        output?.serviceName ??
        armName(application, olds?.name ?? (yield* createEntityName(id)));
      const observed = yield* getService(
        subscriptionId,
        resourceGroup,
        cluster,
        application,
        serviceName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        cluster,
        application,
        serviceName,
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceFabric");
      const { resourceGroup, cluster, application } = news;
      const serviceName = news.name
        ? armName(application, news.name)
        : (output?.serviceName ??
          armName(application, yield* createEntityName(id)));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        applicationName: application,
        serviceName,
      };
      const get = getService(
        subscriptionId,
        resourceGroup,
        cluster,
        application,
        serviceName,
      );
      const waitReady = waitForProvisioned(
        `service fabric service ${serviceName}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );
      const mutable = patchable(news);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* servicefabric.ServicesCreateOrUpdate({
          ...where,
          tags,
          properties: {
            ...mutable,
            serviceKind: news.serviceKind,
            serviceTypeName: news.serviceTypeName,
            partitionDescription: news.partitionDescription ?? {
              partitionScheme: "Singleton",
            },
            servicePackageActivationMode: news.servicePackageActivationMode,
            serviceDnsName: news.serviceDnsName,
            hasPersistedState: news.hasPersistedState,
          },
        });
      }
      observed = yield* waitReady;

      // Sync. PATCH only the observed delta.
      const changed = delta(mutable, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (changed !== undefined || tagsChanged) {
        yield* servicefabric.UpdateService({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: { ...changed, serviceKind: news.serviceKind },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, cluster, application, serviceName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicefabric.DeleteService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationName: output.application,
          serviceName: output.serviceName,
        }),
      );
      yield* waitUntilGone(
        `service fabric service ${output.serviceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.application,
          output.serviceName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceFabricClassic.Application",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
