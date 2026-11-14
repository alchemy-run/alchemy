import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster as RivetCluster } from "../Cluster.ts";
import { Namespace } from "../Namespace.ts";
import { Cluster, type ClusterProps } from "./Cluster.ts";

export interface ControlPlaneProps extends ClusterProps {}

/**
 * A Rivet Cloud cluster, as a `Rivet.Cluster` Layer. Rivet runs the control
 * plane; your pools of nodes run wherever their pool Layer puts them and
 * connect out to it. Each stage gets a namespace of its own on the cluster.
 *
 * Deploys sign in to Rivet Cloud with the `RivetCloud` profile (a browser
 * sign-in, or a cluster token), or with `RIVET_CLOUD_TOKEN` and
 * `RIVET_CLOUD_CLUSTER` in CI. Self-hosted control planes need neither.
 *
 * ### Connecting to Rivet Cloud
 * **Example:** The cluster chosen at sign-in
 * ```typescript
 * export const Cluster = RivetCloud.ControlPlane("Rivet");
 * export const Default = RivetAWS.EcsPool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** A cluster by its name
 * ```typescript
 * export const Cluster = RivetCloud.ControlPlane("Rivet", { cluster: "acme" });
 * ```
 *
 * @primitive
 */
export const ControlPlane = (id: string, props: ControlPlaneProps = {}) =>
  Layer.effect(
    RivetCluster,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their endpoint and token from their own
        // environment at runtime; the cluster is only consulted while deploying.
        return { endpoint: "", token: Redacted.make(""), namespace: "default" };
      }
      const cluster = yield* Cluster(id, props);
      const namespace = yield* Namespace(`${id}Namespace`, {
        endpoint: cluster.endpoint,
        token: cluster.adminToken,
      });
      return {
        endpoint: cluster.endpoint,
        token: cluster.adminToken,
        namespace: namespace.name,
        rivetCloudCluster: cluster.name,
      };
    }),
  );
