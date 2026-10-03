import * as kr from "@distilled.cloud/azure/kubernetesruntime";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { RUNTIME_WAIT, runtimeState, sameId } from "./Common.ts";

/**
 * Kubernetes runtime feature to enable on the cluster: `storageclass`
 * (Arc storage class management) or `networking` (MetalLB load balancers
 * and BGP peers).
 */
export type KubernetesRuntimeServiceName = "storageclass" | "networking";

export interface ServiceProps {
  /**
   * ARM resource ID of the Azure Arc-enabled Kubernetes cluster
   * (`Microsoft.Kubernetes/connectedClusters`). Changing it replaces the
   * service.
   */
  clusterId: string;
  /**
   * Feature to enable: `storageclass` or `networking`. Changing it
   * replaces the service.
   */
  serviceName: KubernetesRuntimeServiceName;
}

export interface Service extends Resource<
  "Azure.KubernetesRuntime.Service",
  ServiceProps,
  {
    /** ARM resource ID of the service. */
    serviceId: string;
    /** ARM resource ID of the connected cluster. */
    clusterId: string;
    /** Name of the service (`storageclass` or `networking`). */
    serviceName: string;
    /**
     * Object ID of the resource provider's service principal in the tenant,
     * used to grant it access to the cluster.
     */
    rpObjectId: string | undefined;
    /** Observed provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables a Kubernetes runtime feature (`storageclass` or `networking`) on
 * an Azure Arc-enabled Kubernetes cluster. It is an extension resource of
 * the connected cluster and a prerequisite for
 * `Azure.KubernetesRuntime.StorageClass`, `LoadBalancer` and `BgpPeer`.
 *
 * The cluster must be connected (Arc agents installed and reporting); ARM
 * proxies every write to the cluster and times out otherwise. Services
 * carry no tags, so a service found at the expected scope is only treated
 * as owned when Alchemy created it.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/kubernetes/
 *
 * ### Enabling Features
 * **Example:** Enable Arc storage class management
 * ```typescript
 * yield* Azure.KubernetesRuntime.Service("storage", {
 *   clusterId: "/subscriptions/.../connectedClusters/edge-cluster",
 *   serviceName: "storageclass",
 * });
 * ```
 *
 * **Example:** Enable Arc networking (MetalLB)
 * ```typescript
 * const networking = yield* Azure.KubernetesRuntime.Service("networking", {
 *   clusterId,
 *   serviceName: "networking",
 * });
 * ```
 *
 * @resource
 */
export const Service = Resource<Service>("Azure.KubernetesRuntime.Service");

const getService = (resourceUri: string, serviceName: string) =>
  orUndefinedIfNotFound(kr.GetService({ resourceUri, serviceName }));

const toAttrs = (
  clusterId: string,
  serviceName: string,
  observed: kr.GetServiceResponse,
): Service["Attributes"] => ({
  serviceId: observed.id ?? "",
  clusterId,
  serviceName,
  rpObjectId: observed.properties?.rpObjectId,
  provisioningState: observed.properties?.provisioningState,
});

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serviceId", "clusterId", "serviceName"],

    // Extension resources vanish with the cluster they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.clusterId, output.clusterId) ||
        news.serviceName.toLowerCase() !== output.serviceName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const clusterId = output?.clusterId ?? olds?.clusterId;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (clusterId === undefined || serviceName === undefined) {
        return undefined;
      }
      const observed = yield* getService(clusterId, serviceName);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, serviceName, observed);
      // No tags or markers: only a service we persisted is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KubernetesRuntime");
      const { clusterId, serviceName } = news;
      const get = getService(clusterId, serviceName);

      // Observe; existence-only, nothing mutable to sync.
      const observed = yield* get;
      if (observed === undefined) {
        yield* kr.ServicesCreateOrUpdate({
          resourceUri: clusterId,
          serviceName,
          properties: {},
        });
      }

      const fresh = yield* waitForProvisioned(
        `kubernetes runtime service ${clusterId}/${serviceName}`,
        get,
        runtimeState,
        RUNTIME_WAIT,
      );
      return toAttrs(clusterId, serviceName, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        kr.DeleteService({
          resourceUri: output.clusterId,
          serviceName: output.serviceName,
        }),
      );
      yield* waitUntilGone(
        `kubernetes runtime service ${output.clusterId}/${output.serviceName}`,
        getService(output.clusterId, output.serviceName),
        RUNTIME_WAIT,
      );
    }),
  });
