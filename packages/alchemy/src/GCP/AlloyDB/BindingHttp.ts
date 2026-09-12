import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Backup } from "./Backup.ts";
import type { Cluster } from "./Cluster.ts";
import type { ClustersUser } from "./ClustersUser.ts";
import type { Instance } from "./Instance.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for AlloyDB cluster, instance, backup, and
 * user bindings. NOT exported from index.ts.
 */
export const makeAlloyDbClusterHttpBinding = <
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

export const makeAlloyDbInstanceHttpBinding = <
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
    return Effect.fn(function* (instance: Instance) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: instance,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* instance.name;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeAlloyDbBackupHttpBinding = <
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
    return Effect.fn(function* (backup: Backup) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: backup,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* backup.name;
      return Effect.fn(`${options.tag}(${backup.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeAlloyDbUserHttpBinding = <
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
    return Effect.fn(function* (user: ClustersUser) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: user,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* user.name;
      return Effect.fn(`${options.tag}(${user.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeAlloyDbConnectionInfoHttpBinding = <
  I extends { parent?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (instance: Instance) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: instance,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* instance.name;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "parent">,
      ) {
        return yield* run({
          ...(request as I),
          parent: yield* name,
        } as I);
      });
    });
  });
