import type { AzureOpContext, AzureOpError } from "@distilled.cloud/azure";
import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";

/** Resource provider namespace of Azure IoT Operations. */
export const IOT_OPERATIONS_NAMESPACE = "Microsoft.IoTOperations";

/**
 * Deterministic Kubernetes-compatible name (lowercase letters, digits,
 * and hyphens, at most 63 characters). Every IoT Operations resource is
 * projected as a custom resource on the Arc-enabled cluster.
 */
export const createIotName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true });

/** Case-insensitive equality of ARM names and IDs. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
};

/** Structural equality of plain prop values (key order and `undefined` ignored). */
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Whether every value set in `desired` is present in `observed`. The
 * service fills in defaults on GET, so desired state is compared as a
 * subset; arrays must match element by element.
 */
export const isSubset = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, index) => isSubset(item, observed[index]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    const want = desired as Record<string, unknown>;
    const have = observed as Record<string, unknown>;
    return Object.keys(want).every((key) => isSubset(want[key], have[key]));
  }
  return desired === observed;
};

/** Read an IoT Operations instance, or `undefined` when missing. */
export const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  instanceName: string,
) =>
  orUndefinedIfNotFound(
    iot.GetInstance({ subscriptionId, resourceGroupName, instanceName }),
  );

/**
 * Whether the parent instance belongs to the current stack and stage.
 * Child resources carry no ARM tags, so ownership follows the instance's
 * `alchemy::stack` / `alchemy::stage` tags.
 */
export const isInstanceOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  instanceName: string,
) {
  const instance = yield* getInstance(
    subscriptionId,
    resourceGroupName,
    instanceName,
  );
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(instance?.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Shared identity of every child resource: the instance it lives in. */
export interface InstanceScope {
  readonly resourceGroup: string;
  readonly instanceName: string;
}

/** Child path: its parent scope plus its own name. */
export type ChildKey<S extends InstanceScope> = S & { readonly name: string };

/** Fields every child GET response carries. */
export interface ChildObserved {
  id?: string;
  properties?: {
    provisioningState?: string;
    healthState?: string;
  };
  extendedLocation?: iot.ExtendedLocation;
}

type Op<A> = Effect.Effect<A, AzureOpError, AzureOpContext>;

/** Description of one IoT Operations child resource. */
export interface ChildSpec<
  P extends InstanceScope & { name?: string },
  A extends object,
  S extends InstanceScope,
  O extends ChildObserved,
  B extends object,
> {
  /** Human-readable kind for wait/timeout messages, e.g. `broker listener`. */
  kind: string;
  /** Parent scope from props. */
  scopeOf: (props: P) => S;
  /** Child path recorded in the attributes. */
  keyOfAttrs: (attrs: A) => ChildKey<S>;
  /** Name used when `props.name` is omitted. @default a generated name */
  defaultName?: string;
  /** GET the child; typed not-found errors mean missing. */
  get: (subscriptionId: string, key: ChildKey<S>) => Op<O>;
  /** Create or update the child (full PUT). */
  put: (
    subscriptionId: string,
    key: ChildKey<S>,
    properties: B,
    extendedLocation: iot.ExtendedLocation | undefined,
  ) => Op<unknown>;
  /** Delete the child. */
  remove: (subscriptionId: string, key: ChildKey<S>) => Op<unknown>;
  /** Desired `properties` body from props. */
  bodyOf: (props: P) => B;
  /** Body fields that cannot change in place; changing one replaces the child. */
  immutable?: ReadonlyArray<keyof B & string>;
  /** Attributes of the observed child. */
  toAttrs: (key: ChildKey<S>, observed: O) => A;
}

const LRO_BUDGET = { interval: "10 seconds", times: 60 } as const;

/**
 * Lifecycle operations (diff/read/reconcile/delete/list) for an IoT
 * Operations child resource. Spread into `Provider.succeed(Resource, ...)`.
 *
 * Children share the instance's Arc custom location: the PUT reuses the
 * observed child's `extendedLocation`, else the parent instance's.
 */
export const childLifecycle = <
  P extends InstanceScope & { name?: string },
  A extends object,
  S extends InstanceScope,
  O extends ChildObserved,
  B extends object,
>(
  spec: ChildSpec<P, A, S, O, B>,
) => {
  const get = (subscriptionId: string, key: ChildKey<S>) =>
    orUndefinedIfNotFound(spec.get(subscriptionId, key));
  const label = (key: ChildKey<S>) =>
    `IoT Operations ${spec.kind} ${key.name} (instance ${key.instanceName})`;
  const keyOf = (props: P, id: string, output: A | undefined) =>
    Effect.gen(function* () {
      const name =
        props.name ??
        (output === undefined ? undefined : spec.keyOfAttrs(output).name) ??
        spec.defaultName ??
        (yield* createIotName(id));
      return { ...spec.scopeOf(props), name } as ChildKey<S>;
    });

  return {
    // Children live inside an instance; nuke removes them with it.
    list: Effect.fn(function* () {
      return [] as A[];
    }),

    diff: Effect.fn(function* ({
      news,
      olds,
      output,
    }: {
      id: string;
      news: Input<P>;
      olds: P | undefined;
      output: A | undefined;
    }) {
      if (!isResolved<P>(news) || output === undefined) return undefined;
      const recorded = spec.keyOfAttrs(output) as Record<string, unknown>;
      const scope = spec.scopeOf(news) as Record<string, unknown>;
      const scopeChanged = Object.keys(scope).some(
        (field) =>
          !sameId(String(scope[field] ?? ""), String(recorded[field] ?? "")),
      );
      const nameChanged =
        news.name !== undefined && !sameId(news.name, String(recorded.name));
      const immutableChanged =
        olds !== undefined &&
        (spec.immutable ?? []).some(
          (field) =>
            !sameValue(spec.bodyOf(news)[field], spec.bodyOf(olds)[field]),
        );
      if (scopeChanged || nameChanged || immutableChanged) {
        // An explicit (or fixed default) name is reused by the replacement
        // in the same scope, so the old child must go first.
        return {
          action: "replace",
          deleteFirst:
            !scopeChanged &&
            (news.name !== undefined || spec.defaultName !== undefined),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({
      id,
      olds,
      output,
    }: {
      id: string;
      olds: P | undefined;
      output: A | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const key =
        output !== undefined
          ? spec.keyOfAttrs(output)
          : olds !== undefined && olds.resourceGroup !== undefined
            ? yield* keyOf(olds, id, undefined)
            : undefined;
      if (key === undefined) return undefined;
      const observed = yield* get(subscriptionId, key);
      if (observed === undefined) return undefined;
      const attrs = spec.toAttrs(key, observed);
      return (yield* isInstanceOwned(
        subscriptionId,
        key.resourceGroup,
        key.instanceName,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({
      id,
      news,
      output,
    }: {
      id: string;
      news: P;
      olds: P | undefined;
      output: A | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, IOT_OPERATIONS_NAMESPACE);
      const key = yield* keyOf(news, id, output);
      const desired = spec.bodyOf(news);

      // Observe, then create or converge with one full PUT when the
      // observed properties do not already contain the desired ones.
      const observed = yield* get(subscriptionId, key);
      if (
        observed === undefined ||
        !isSubset(desired, observed.properties ?? {})
      ) {
        const extendedLocation =
          observed?.extendedLocation ??
          (yield* getInstance(
            subscriptionId,
            key.resourceGroup,
            key.instanceName,
          ))?.extendedLocation;
        yield* spec.put(subscriptionId, key, desired, extendedLocation);
      }
      const current = yield* waitForProvisioned(
        label(key),
        get(subscriptionId, key),
        (value) => value.properties?.provisioningState,
        LRO_BUDGET,
      );
      return spec.toAttrs(key, current);
    }),

    delete: Effect.fn(function* ({ output }: { output: A }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const key = spec.keyOfAttrs(output);
      yield* ignoreNotFound(spec.remove(subscriptionId, key));
      yield* waitUntilGone(label(key), get(subscriptionId, key), LRO_BUDGET);
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.IoTOperations.Instance",
      ],
    },
  };
};

/** Attributes shared by every child resource. */
export const childStatus = (observed: ChildObserved) => ({
  provisioningState: observed.properties?.provisioningState,
  healthState: observed.properties?.healthState,
});
