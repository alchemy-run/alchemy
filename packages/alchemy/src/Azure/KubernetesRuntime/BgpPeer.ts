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
} from "./Common.ts";

export interface BgpPeerProps {
  /**
   * ARM resource ID of the Azure Arc-enabled Kubernetes cluster
   * (`Microsoft.Kubernetes/connectedClusters`). The cluster needs the
   * `networking` `Azure.KubernetesRuntime.Service`. Changing it replaces
   * the peer.
   */
  clusterId: string;
  /**
   * Name of the BGP peer (3-24 letters, digits and `-`). If omitted, a
   * unique lowercase name is generated. Changing it replaces the peer.
   */
  name?: string;
  /** Autonomous system number the cluster's speakers announce. */
  myAsn: number;
  /** Autonomous system number of the peer router. */
  peerAsn: number;
  /** IP address of the peer router. */
  peerAddress: string;
}

export interface BgpPeer extends Resource<
  "Azure.KubernetesRuntime.BgpPeer",
  BgpPeerProps,
  {
    /** ARM resource ID of the BGP peer. */
    bgpPeerId: string;
    /** Name of the BGP peer. */
    bgpPeerName: string;
    /** ARM resource ID of the connected cluster. */
    clusterId: string;
    /** Observed local ASN. */
    myAsn: number;
    /** Observed peer ASN. */
    peerAsn: number;
    /** Observed peer address. */
    peerAddress: string;
    /** Observed provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A BGP peer of the MetalLB speakers on an Azure Arc-enabled Kubernetes
 * cluster, so `Azure.KubernetesRuntime.LoadBalancer` addresses can be
 * advertised to an upstream router (AKS Arc / Azure Local networks).
 *
 * Requires a connected cluster with the `networking` service enabled; ARM
 * proxies every write to the cluster. Peers carry no tags, so a peer found
 * at the expected scope is only treated as owned when Alchemy created it.
 *
 * @see https://learn.microsoft.com/azure/aks/aksarc/networking
 *
 * ### Peering with a Router
 * **Example:** Peer with a top-of-rack router
 * ```typescript
 * const networking = yield* Azure.KubernetesRuntime.Service("networking", {
 *   clusterId,
 *   serviceName: "networking",
 * });
 * const peer = yield* Azure.KubernetesRuntime.BgpPeer("tor", {
 *   clusterId: networking.clusterId,
 *   myAsn: 64500,
 *   peerAsn: 64501,
 *   peerAddress: "10.0.0.1",
 * });
 * ```
 *
 * @resource
 */
export const BgpPeer = Resource<BgpPeer>("Azure.KubernetesRuntime.BgpPeer");

const getPeer = (resourceUri: string, bgpPeerName: string) =>
  orUndefinedIfNotFound(kr.GetBgpPeer({ resourceUri, bgpPeerName }));

const toAttrs = (
  clusterId: string,
  bgpPeerName: string,
  observed: kr.GetBgpPeerResponse,
): BgpPeer["Attributes"] => ({
  bgpPeerId: observed.id ?? "",
  bgpPeerName,
  clusterId,
  myAsn: observed.properties?.myAsn ?? 0,
  peerAsn: observed.properties?.peerAsn ?? 0,
  peerAddress: observed.properties?.peerAddress ?? "",
  provisioningState: observed.properties?.provisioningState,
});

export const BgpPeerProvider = () =>
  Provider.succeed(BgpPeer, {
    stables: ["bgpPeerId", "bgpPeerName", "clusterId"],

    // Extension resources vanish with the cluster they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.clusterId, output.clusterId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.bgpPeerName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const clusterId = output?.clusterId ?? olds?.clusterId;
      if (clusterId === undefined) return undefined;
      const name =
        output?.bgpPeerName ?? olds?.name ?? (yield* runtimeObjectName(id));
      const observed = yield* getPeer(clusterId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, name, observed);
      // No tags or markers: only a peer we persisted is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KubernetesRuntime");
      const { clusterId } = news;
      const name =
        output?.bgpPeerName ?? news.name ?? (yield* runtimeObjectName(id));
      const get = getPeer(clusterId, name);

      // Observe, then PUT the whole peer when missing or drifted.
      const observed = yield* get;
      const props = observed?.properties;
      if (
        props === undefined ||
        props.myAsn !== news.myAsn ||
        props.peerAsn !== news.peerAsn ||
        props.peerAddress !== news.peerAddress
      ) {
        yield* kr.BgpPeersCreateOrUpdate({
          resourceUri: clusterId,
          bgpPeerName: name,
          properties: {
            myAsn: news.myAsn,
            peerAsn: news.peerAsn,
            peerAddress: news.peerAddress,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `kubernetes runtime bgp peer ${clusterId}/${name}`,
        get,
        runtimeState,
        RUNTIME_WAIT,
      );
      return toAttrs(clusterId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        kr.DeleteBgpPeer({
          resourceUri: output.clusterId,
          bgpPeerName: output.bgpPeerName,
        }),
      );
      yield* waitUntilGone(
        `kubernetes runtime bgp peer ${output.clusterId}/${output.bgpPeerName}`,
        getPeer(output.clusterId, output.bgpPeerName),
        RUNTIME_WAIT,
      );
    }),
  });
