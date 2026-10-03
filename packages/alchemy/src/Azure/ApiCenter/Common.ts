import type { AzureOpContext, AzureOpError } from "@distilled.cloud/azure";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  type ProvisioningFailed,
  type ProvisioningTimedOut,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";

/**
 * API Center (2024-03-01) only supports the auto-created `default`
 * workspace, which lives and dies with the service.
 */
export const DEFAULT_WORKSPACE = "default";

/**
 * Deterministic name for an API Center service or catalog entity. The
 * spec allows 3-90 characters, but the service RP rejects names longer
 * than 64 (`^[a-zA-Z0-9\-\.]{1,64}$`), so generated names stay within 64.
 */
export const createApiCenterName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true });

/**
 * Deterministic API Center service name: the RP requires 3-50 characters
 * that begin and end with a letter or digit, without consecutive dashes.
 */
export const createServiceName = (id: string) =>
  createPhysicalName({ id, maxLength: 50, lowercase: true });

/** Case-insensitive comparison for Azure names and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Read an API Center service, or `undefined` when missing. */
export const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
) =>
  orUndefinedIfNotFound(
    apicenter.GetService({ subscriptionId, resourceGroupName, serviceName }),
  );

/**
 * Whether the parent service belongs to the current stack and stage.
 * Catalog entities cannot carry ARM tags, so ownership follows the parent
 * service's `alchemy::stack` / `alchemy::stage` tags.
 */
export const isParentOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
) {
  const service = yield* getService(
    subscriptionId,
    resourceGroupName,
    serviceName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    service?.tags?.["alchemy::stack"] === stack &&
    service?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Whether every value set in `desired` is present in `observed`. API Center
 * fills in defaults on GET, so desired state is compared as a subset;
 * arrays must match element by element.
 */
export const subsetMatches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, index) => subsetMatches(item, observed[index]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      subsetMatches(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

/** Path of a catalog entity inside an API Center service. */
export interface EntityKey {
  readonly resourceGroup: string;
  readonly serviceName: string;
}

type Op<A> = Effect.Effect<A, AzureOpError, AzureOpContext>;

/** Context needed to generate a physical name (stack, stage, instance id). */
type NameContext =
  ReturnType<typeof createPhysicalName> extends Effect.Effect<
    unknown,
    unknown,
    infer R
  >
    ? R
    : never;

/** Description of one API Center catalog entity (API, version, ...). */
export interface EntitySpec<
  P extends object,
  A extends object,
  K extends EntityKey,
  O,
> {
  /** Human-readable label for wait/timeout messages. */
  label: (key: K) => string;
  /** Entity path derived from props (generating the name when omitted). */
  keyOf: (
    props: P,
    id: string,
    output: A | undefined,
  ) => Effect.Effect<K, never, NameContext>;
  /** Entity path recorded in the attributes. */
  keyOfAttrs: (attrs: A) => K;
  /** GET the entity. */
  get: (subscriptionId: string, key: K) => Op<O>;
  /** Create or update the entity to match `props` (full-body upsert). */
  put: (subscriptionId: string, key: K, props: P) => Op<unknown>;
  /** Delete the entity. */
  remove: (subscriptionId: string, key: K) => Op<unknown>;
  /** Whether the observed entity already matches `props`. */
  inSync: (props: P, observed: O) => boolean;
  /**
   * Extra sync step after the upsert (e.g. importing a specification).
   * Returns the entity as observed afterwards.
   */
  afterPut?: (
    subscriptionId: string,
    key: K,
    props: P,
    observed: O,
    output: A | undefined,
  ) => Effect.Effect<
    O,
    AzureOpError | ProvisioningFailed | ProvisioningTimedOut,
    AzureOpContext
  >;
  /** Attributes of the observed entity. */
  toAttrs: (subscriptionId: string, key: K, observed: O, props?: P) => A;
}

/** Whether any field of the desired key differs from the recorded one. */
const keysDiffer = (desired: EntityKey, recorded: EntityKey) => {
  const left = desired as unknown as Record<string, unknown>;
  const right = recorded as unknown as Record<string, unknown>;
  return Object.keys(left).some((field) => {
    const l = left[field];
    const r = right[field];
    return typeof l === "string" && typeof r === "string"
      ? !sameName(l, r)
      : l !== r;
  });
};

/**
 * Lifecycle operations (list/diff/read/reconcile/delete) for an API Center
 * catalog entity. Every entity PUT is a synchronous full-body upsert, so
 * reconcile is GET → PUT on drift → GET. Spread into
 * `Provider.succeed(Resource, ...)`.
 */
export const entityLifecycle = <
  P extends object,
  A extends object,
  K extends EntityKey,
  O,
>(
  spec: EntitySpec<P, A, K, O>,
) => {
  const get = (subscriptionId: string, key: K) =>
    orUndefinedIfNotFound(spec.get(subscriptionId, key));

  return {
    // Catalog entities live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [] as A[];
    }),

    diff: Effect.fn(function* ({
      id,
      news,
      output,
    }: {
      id: string;
      news: Input<P>;
      output: A | undefined;
    }) {
      if (!isResolved<P>(news) || output === undefined) return undefined;
      const key = yield* spec.keyOf(news, id, output);
      if (keysDiffer(key, spec.keyOfAttrs(output))) {
        return { action: "replace" } as const;
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
          : olds !== undefined
            ? yield* spec.keyOf(olds, id, undefined)
            : undefined;
      if (key === undefined) return undefined;
      const observed = yield* get(subscriptionId, key);
      if (observed === undefined) return undefined;
      const attrs = spec.toAttrs(subscriptionId, key, observed, olds);
      const owned = yield* isParentOwned(
        subscriptionId,
        key.resourceGroup,
        key.serviceName,
      );
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({
      id,
      news,
      output,
    }: {
      id: string;
      news: P;
      output: A | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiCenter");
      const key = yield* spec.keyOf(news, id, output);

      // Observe, then create or converge with one full-body upsert.
      const observed = yield* get(subscriptionId, key);
      if (observed === undefined || !spec.inSync(news, observed)) {
        yield* spec.put(subscriptionId, key, news);
      }
      let current = yield* waitForProvisioned(
        spec.label(key),
        get(subscriptionId, key),
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      if (spec.afterPut !== undefined) {
        current = yield* spec.afterPut(
          subscriptionId,
          key,
          news,
          current,
          output,
        );
      }
      return spec.toAttrs(subscriptionId, key, current, news);
    }),

    delete: Effect.fn(function* ({ output }: { output: A }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const key = spec.keyOfAttrs(output);
      yield* ignoreNotFound(spec.remove(subscriptionId, key));
      yield* waitUntilGone(spec.label(key), get(subscriptionId, key), {
        interval: "2 seconds",
        times: 30,
      });
    }),

    nuke: { dependsOn: ["Azure.ApiCenter.Service"] },
  };
};
