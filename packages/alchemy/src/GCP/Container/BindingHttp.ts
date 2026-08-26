import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Cluster } from "./Cluster.ts";
import type { ClustersNodePool } from "./ClustersNodePool.ts";
import type { NodePool } from "./NodePool.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for GKE cluster and node pool bindings.
 * NOT exported from index.ts.
 */
export const makeContainerClusterHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (cluster: Cluster) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: cluster,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* cluster.name;
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeContainerNodePoolHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (nodePool: NodePool) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: nodePool,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* nodePool.name;
      return Effect.fn(`${options.tag}(${nodePool.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeContainerClustersNodePoolHttpBinding = <
  I extends {
    projectId: string;
    zone: string;
    clusterId: string;
    nodePoolId: string;
    name?: string;
  },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (nodePool: ClustersNodePool) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: nodePool,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* nodePool.name;
      const project = yield* nodePool.project;
      const zone = yield* nodePool.zone;
      const clusterId = yield* nodePool.clusterId;
      const nodePoolId = yield* nodePool.nodePoolId;
      return Effect.fn(`${options.tag}(${nodePool.LogicalId})`)(function* (
        request?: Omit<
          I,
          "projectId" | "zone" | "clusterId" | "nodePoolId" | "name"
        >,
      ) {
        return yield* run({
          ...(request as I),
          projectId: yield* project,
          zone: yield* zone,
          clusterId: yield* clusterId,
          nodePoolId: yield* nodePoolId,
          name: yield* name,
        } as I);
      });
    });
  });
