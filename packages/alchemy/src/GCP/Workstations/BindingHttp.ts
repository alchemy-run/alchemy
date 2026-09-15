import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { WorkstationCluster } from "./WorkstationCluster.ts";
import type { WorkstationClustersWorkstationConfig } from "./WorkstationClustersWorkstationConfig.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud Workstations bindings.
 * NOT exported from index.ts.
 */
export const makeClusterHttpBinding = <
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
    return Effect.fn(function* (cluster: WorkstationCluster) {
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

export const makeConfigHttpBinding = <
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
    return Effect.fn(function* (config: WorkstationClustersWorkstationConfig) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: config,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* config.name;
      return Effect.fn(`${options.tag}(${config.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeWorkstationHttpBinding = <
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
    return Effect.fn(function* (
      workstation: WorkstationClustersWorkstationConfigsWorkstation,
    ) {
      const name = yield* workstation.name;
      return Effect.fn(`${options.tag}(${workstation.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeGenerateAccessTokenHttpBinding = <
  I extends { workstation?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (
      workstation: WorkstationClustersWorkstationConfigsWorkstation,
    ) {
      const name = yield* workstation.name;
      return Effect.fn(`${options.tag}(${workstation.LogicalId})`)(function* (
        request?: Omit<I, "workstation">,
      ) {
        return yield* run({
          ...(request as I),
          workstation: yield* name,
        } as I);
      });
    });
  });
