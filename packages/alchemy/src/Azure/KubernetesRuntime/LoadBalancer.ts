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
import {
  RUNTIME_WAIT,
  runtimeObjectName,
  runtimeState,
  sameId,
  sameList,
  sameMap,
} from "./Common.ts";

/** How load balancer addresses are announced: `ARP`, `BGP` or `Both`. */
export type LoadBalancerAdvertiseMode = kr.AdvertiseMode;

export interface LoadBalancerProps {
  /**
   * ARM resource ID of the Azure Arc-enabled Kubernetes cluster
   * (`Microsoft.Kubernetes/connectedClusters`). The cluster needs the
   * `networking` `Azure.KubernetesRuntime.Service`. Changing it replaces
   * the load balancer.
   */
  clusterId: string;
  /**
   * Name of the load balancer (3-24 letters, digits and `-`). If omitted,
   * a unique lowercase name is generated. Changing it replaces the load
   * balancer.
   */
  name?: string;
  /**
   * IP ranges handed out to `LoadBalancer` Services, as CIDRs
   * (`192.168.10.0/24`) or ranges (`192.168.10.10-192.168.10.20`).
   */
  addresses: string[];
  /**
   * How the addresses are announced: `ARP` (layer 2), `BGP`, or `Both`.
   */
  advertiseMode: LoadBalancerAdvertiseMode;
  /**
   * Label selector restricting which Kubernetes Services get addresses
   * from this pool, e.g. `{ "a": "b" }`. Omit to serve every Service.
   */
  serviceSelector?: Record<string, string>;
  /**
   * Names of `Azure.KubernetesRuntime.BgpPeer`s to advertise to. Omit or
   * leave empty to advertise to all peers.
   */
  bgpPeers?: string[];
}

export interface LoadBalancer extends Resource<
  "Azure.KubernetesRuntime.LoadBalancer",
  LoadBalancerProps,
  {
    /** ARM resource ID of the load balancer. */
    loadBalancerId: string;
    /** Name of the load balancer. */
    loadBalancerName: string;
    /** ARM resource ID of the connected cluster. */
    clusterId: string;
    /** Observed address ranges. */
    addresses: string[];
    /** Observed advertise mode. */
    advertiseMode: string;
    /** Observed service selector. */
    serviceSelector: Record<string, string>;
    /** Observed BGP peer names. */
    bgpPeers: string[];
    /** Observed provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A MetalLB address pool on an Azure Arc-enabled Kubernetes cluster:
 * Kubernetes Services of type `LoadBalancer` get external IPs from
 * `addresses`, announced via ARP and/or BGP (AKS Arc / Azure Local).
 *
 * Requires a connected cluster with the `networking` service enabled; ARM
 * proxies every write to the cluster. Load balancers carry no tags, so one
 * found at the expected scope is only treated as owned when Alchemy
 * created it.
 *
 * @see https://learn.microsoft.com/azure/aks/aksarc/networking
 *
 * ### Address Pools
 * **Example:** Layer-2 (ARP) pool
 * ```typescript
 * const networking = yield* Azure.KubernetesRuntime.Service("networking", {
 *   clusterId,
 *   serviceName: "networking",
 * });
 * yield* Azure.KubernetesRuntime.LoadBalancer("pool", {
 *   clusterId: networking.clusterId,
 *   addresses: ["192.168.10.0/28"],
 *   advertiseMode: "ARP",
 * });
 * ```
 *
 * **Example:** BGP pool for selected services
 * ```typescript
 * yield* Azure.KubernetesRuntime.LoadBalancer("public", {
 *   clusterId: networking.clusterId,
 *   addresses: ["10.20.0.10-10.20.0.20"],
 *   advertiseMode: "BGP",
 *   serviceSelector: { exposure: "public" },
 *   bgpPeers: [peer.bgpPeerName],
 * });
 * ```
 *
 * @resource
 */
export const LoadBalancer = Resource<LoadBalancer>(
  "Azure.KubernetesRuntime.LoadBalancer",
);

const getLoadBalancer = (resourceUri: string, loadBalancerName: string) =>
  orUndefinedIfNotFound(kr.GetLoadBalancer({ resourceUri, loadBalancerName }));

const toAttrs = (
  clusterId: string,
  loadBalancerName: string,
  observed: kr.GetLoadBalancerResponse,
): LoadBalancer["Attributes"] => ({
  loadBalancerId: observed.id ?? "",
  loadBalancerName,
  clusterId,
  addresses: [...(observed.properties?.addresses ?? [])],
  advertiseMode: observed.properties?.advertiseMode ?? "",
  serviceSelector: Object.fromEntries(
    Object.entries(observed.properties?.serviceSelector ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  bgpPeers: [...(observed.properties?.bgpPeers ?? [])],
  provisioningState: observed.properties?.provisioningState,
});

export const LoadBalancerProvider = () =>
  Provider.succeed(LoadBalancer, {
    stables: ["loadBalancerId", "loadBalancerName", "clusterId"],

    // Extension resources vanish with the cluster they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.clusterId, output.clusterId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.loadBalancerName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const clusterId = output?.clusterId ?? olds?.clusterId;
      if (clusterId === undefined) return undefined;
      const name =
        output?.loadBalancerName ??
        olds?.name ??
        (yield* runtimeObjectName(id));
      const observed = yield* getLoadBalancer(clusterId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, name, observed);
      // No tags or markers: only a load balancer we persisted is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KubernetesRuntime");
      const { clusterId } = news;
      const name =
        output?.loadBalancerName ?? news.name ?? (yield* runtimeObjectName(id));
      const get = getLoadBalancer(clusterId, name);

      // Observe, then PUT the whole pool when missing or drifted (no PATCH).
      const observed = yield* get;
      const props = observed?.properties;
      if (
        props === undefined ||
        !sameList(props.addresses, news.addresses) ||
        props.advertiseMode !== news.advertiseMode ||
        !sameMap(props.serviceSelector, news.serviceSelector) ||
        !sameList(props.bgpPeers, news.bgpPeers)
      ) {
        yield* kr.LoadBalancersCreateOrUpdate({
          resourceUri: clusterId,
          loadBalancerName: name,
          properties: {
            addresses: news.addresses,
            advertiseMode: news.advertiseMode,
            serviceSelector: news.serviceSelector,
            bgpPeers: news.bgpPeers,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `kubernetes runtime load balancer ${clusterId}/${name}`,
        get,
        runtimeState,
        RUNTIME_WAIT,
      );
      return toAttrs(clusterId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        kr.DeleteLoadBalancer({
          resourceUri: output.clusterId,
          loadBalancerName: output.loadBalancerName,
        }),
      );
      yield* waitUntilGone(
        `kubernetes runtime load balancer ${output.clusterId}/${output.loadBalancerName}`,
        getLoadBalancer(output.clusterId, output.loadBalancerName),
        RUNTIME_WAIT,
      );
    }),
  });
