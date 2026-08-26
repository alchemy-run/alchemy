import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Cluster } from "./Cluster.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Dataproc cluster bindings.
 * NOT exported from index.ts.
 */
export const makeDataprocClusterHttpBinding = <
  I extends { projectId?: string; region?: string; clusterName?: string },
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
      const clusterName = yield* cluster.clusterName;
      const region = yield* cluster.region;
      const project = yield* cluster.project;
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "region" | "clusterName">,
      ) {
        return yield* run({
          ...(request as I),
          clusterName: yield* clusterName,
          region: yield* region,
          projectId: yield* project,
        } as I);
      });
    });
  });
