import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Shared HTTP scaffolding for SKE bindings.
 * NOT exported from index.ts.
 *
 * Each binding grants a custom role holding exactly the operation's action, on
 * the project holding the cluster: STACKIT has no role binding on a single
 * cluster (see `StackitBindings`). The action names come from the
 * `x-stackit-authorization` of each operation in STACKIT's SKE API spec.
 */
export const SKE_ACCESS = {
  getCluster: { permissions: ["ske.cluster.get"] },
  listClusters: { permissions: ["ske.cluster.list"] },
  createKubeconfig: { permissions: ["ske.cluster.kubeconfig.create"] },
  hibernate: { permissions: ["ske.cluster.hibernate"] },
  wakeup: { permissions: ["ske.cluster.wakeup"] },
  maintain: { permissions: ["ske.cluster.maintain"] },
  reconcile: { permissions: ["ske.cluster.reconcile"] },
  rotateCredentials: { permissions: ["ske.cluster.credential.rotate"] },
} as const satisfies Record<string, StackitBindings.Access>;

/** Build a binding over one operation on a cluster: `<Op>Http.ts` is one call to it. */
export const makeClusterHttpBinding = <
  I extends { projectId: string; region: string; clusterName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SKE.GetCluster`. */
  tag: string;
  /** What the operation needs on the project holding the cluster. */
  access: StackitBindings.Access;
  /** The distilled operation; the cluster's project, region and name are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (cluster: Cluster) => ({
      projectId: cluster.projectId,
      region: cluster.region,
      clusterName: cluster.clusterName,
    }),
    grants: (cluster) => [StackitBindings.grantOn(cluster, options.access)],
  });

/** Build a binding over an operation on the project and region holding a cluster. */
export const makeClusterScopeHttpBinding = <
  I extends { projectId: string; region: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SKE.ListClusters`. */
  tag: string;
  /** What the operation needs on the project holding the cluster. */
  access: StackitBindings.Access;
  /** The distilled operation; the cluster's project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (cluster: Cluster) => ({
      projectId: cluster.projectId,
      region: cluster.region,
    }),
    grants: (cluster) => [StackitBindings.grantOn(cluster, options.access)],
  });

/**
 * Build a binding over an operation with no project in its path: nothing is bound
 * and no role is granted. The host still gets a service account and key, to sign
 * with.
 */
export const makeRegionHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SKE.ListProviderOptions`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({});
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* run(request);
      });
    });
  });
