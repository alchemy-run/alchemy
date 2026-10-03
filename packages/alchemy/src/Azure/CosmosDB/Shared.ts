import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";
import { stackAndStage, waitForProvisioned } from "../Arm.ts";

/**
 * Cosmos DB serializes control-plane operations per account: a child PUT or
 * DELETE that races another operation on the same account fails with
 * `Conflict` / `PreconditionFailed` ("another operation is in progress").
 * Those are retried for a bounded time.
 */
export const whileAccountBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "ResourceConflict" || e._tag === "PreconditionFailed",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

/** ARM ID of a Cosmos DB database account. */
export const accountIdOf = (
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.DocumentDB/databaseAccounts/${accountName}`;

/**
 * Wait for a Cosmos DB child resource after a PUT. Cosmos answers every PUT
 * with `202 Accepted` and applies it asynchronously; the GET keeps returning
 * the previous state (or 404) until it lands. `converged` decides when the
 * observed resource reflects the desired state.
 */
export const waitForChild = <A, R>(
  label: string,
  get: Effect.Effect<A | undefined, AzureOpError, R>,
  converged: (value: A) => boolean,
) =>
  waitForProvisioned(
    label,
    get,
    (value) => (converged(value) ? undefined : "Updating"),
    { interval: "3 seconds", times: 60 },
  );

/**
 * Expand a scope relative to the account (`/`, `/dbs/x`, `dbs/x/colls/y`)
 * to a full ARM ID. Full ARM IDs pass through.
 */
export const expandScope = (accountId: string, scope: string) => {
  if (scope.toLowerCase().startsWith("/subscriptions/")) return scope;
  const relative = scope.replace(/^\/+|\/+$/g, "");
  return relative ? `${accountId}/${relative}` : accountId;
};

/**
 * Ownership of a Cosmos DB child resource (database, container, collection,
 * table). Cosmos accepts but does not persist tags on them, so there is no
 * marker to read back. A resource Alchemy already recorded (`output`) or one
 * found under a generated name (which embeds the instance ID) is ours; one
 * found under a user-chosen name before Alchemy recorded it is foreign.
 */
export const isOwnedChild = (
  output: unknown,
  explicitName: string | undefined,
) => output !== undefined || explicitName === undefined;

/** Deterministic GUID derived from the stack, stage, logical ID, and instance ID. */
export const deterministicGuid = Effect.fn(function* (
  id: string,
  instanceId: string,
) {
  const { stack, stage } = yield* stackAndStage;
  const hex = yield* Effect.sync(() =>
    createHash("sha256")
      .update(`${stack}/${stage}/${id}/${instanceId}`)
      .digest("hex"),
  );
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
});

/** Canonical JSON (sorted keys, `undefined` dropped) for structural comparison. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  ) ?? "undefined";

/** Desired throughput of a database, container, collection, or table. */
export interface ThroughputProps {
  /**
   * Manual (fixed) throughput in RU/s. Mutually exclusive with
   * `autoscaleMaxThroughput`. Not allowed on serverless accounts. Adding or
   * removing dedicated throughput replaces the resource.
   */
  throughput?: number;
  /**
   * Autoscale maximum throughput in RU/s (scales between 10% and 100% of
   * this value). Mutually exclusive with `throughput`. Not allowed on
   * serverless accounts. Adding or removing dedicated throughput replaces
   * the resource.
   */
  autoscaleMaxThroughput?: number;
}

/** Create-time `options` for a Cosmos DB child PUT. */
export const createOptions = (props: ThroughputProps) =>
  props.autoscaleMaxThroughput !== undefined
    ? { autoscaleSettings: { maxThroughput: props.autoscaleMaxThroughput } }
    : props.throughput !== undefined
      ? { throughput: props.throughput }
      : undefined;

export const hasDedicatedThroughput = (props: ThroughputProps) =>
  props.throughput !== undefined || props.autoscaleMaxThroughput !== undefined;

interface ObservedThroughput {
  readonly properties?: {
    readonly resource?: {
      readonly throughput?: number;
      readonly autoscaleSettings?: { readonly maxThroughput: number };
    };
  };
}

/**
 * Converge dedicated throughput on a resource that was created with it.
 * Switching between manual and autoscale uses the `migrate*` operations;
 * value changes go through the `throughputSettings/default` PUT.
 */
export const syncThroughput = <R>(
  label: string,
  desired: ThroughputProps,
  ops: {
    readonly get: Effect.Effect<ObservedThroughput, AzureOpError, R>;
    readonly update: (resource: {
      throughput?: number;
      autoscaleSettings?: { maxThroughput: number };
    }) => Effect.Effect<unknown, AzureOpError, R>;
    readonly toAutoscale: Effect.Effect<unknown, AzureOpError, R>;
    readonly toManual: Effect.Effect<unknown, AzureOpError, R>;
  },
) =>
  Effect.gen(function* () {
    if (!hasDedicatedThroughput(desired)) {
      return { throughput: undefined, autoscaleMaxThroughput: undefined };
    }
    const wantAutoscale = desired.autoscaleMaxThroughput !== undefined;
    const isAutoscale = (o: ObservedThroughput) =>
      o.properties?.resource?.autoscaleSettings !== undefined;
    const matches = (o: ObservedThroughput) =>
      wantAutoscale
        ? o.properties?.resource?.autoscaleSettings?.maxThroughput ===
          desired.autoscaleMaxThroughput
        : !isAutoscale(o) &&
          o.properties?.resource?.throughput === desired.throughput;

    let observed = yield* ops.get;
    if (isAutoscale(observed) !== wantAutoscale) {
      yield* (wantAutoscale ? ops.toAutoscale : ops.toManual).pipe(
        Effect.retry(whileAccountBusy),
      );
      observed = yield* waitForProvisioned(
        `${label} throughput mode`,
        ops.get,
        (o) => (isAutoscale(o) === wantAutoscale ? undefined : "Migrating"),
        { interval: "3 seconds", times: 60 },
      );
    }
    if (!matches(observed)) {
      yield* ops
        .update(
          wantAutoscale
            ? {
                autoscaleSettings: {
                  maxThroughput: desired.autoscaleMaxThroughput!,
                },
              }
            : { throughput: desired.throughput },
        )
        .pipe(Effect.retry(whileAccountBusy));
      observed = yield* waitForProvisioned(
        `${label} throughput`,
        ops.get,
        (o) => (matches(o) ? undefined : "Updating"),
        { interval: "3 seconds", times: 60 },
      );
    }
    const resource = observed.properties?.resource;
    return {
      throughput: resource?.autoscaleSettings ? undefined : resource?.throughput,
      autoscaleMaxThroughput: resource?.autoscaleSettings?.maxThroughput,
    };
  });
