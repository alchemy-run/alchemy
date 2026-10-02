import type { AzureOpContext, AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import { isParentOwned, sameName } from "./Common.ts";
import { normalizePolicy } from "./ServicePolicy.ts";

/**
 * Path of an API Management child entity. Every string field is part of
 * the entity's identity: changing any of them replaces the entity.
 */
export interface EntityKey {
  readonly resourceGroup: string;
  readonly serviceName: string;
}

type Op<A> = Effect.Effect<A, AzureOpError, AzureOpContext>;

/**
 * Description of one API Management child entity (an API's tag link, a
 * product policy, a workspace backend, ...). Child entities carry no ARM
 * tags; ownership follows the parent service's alchemy tags.
 */
export interface EntitySpec<
  P extends object,
  A extends object,
  K extends EntityKey,
  O,
> {
  /** Human-readable label for wait/timeout messages. */
  label: (key: K) => string;
  /** Entity path derived from props (generating the entity name when omitted). */
  keyOf: (props: P, id: string, output: A | undefined) => Effect.Effect<K>;
  /** Entity path recorded in the attributes. */
  keyOfAttrs: (attrs: A) => K;
  /** GET the entity; typed not-found errors mean missing. */
  get: (subscriptionId: string, key: K) => Op<O | undefined>;
  /** Create or update the entity to match `props`. */
  put: (subscriptionId: string, key: K, props: P) => Op<unknown>;
  /** Delete the entity. Absent: the entity cannot be deleted (singleton). */
  remove?: (subscriptionId: string, key: K) => Op<unknown>;
  /**
   * Whether the observed entity already matches `props`. Absent:
   * existence-only. `olds` is only a hint for write-only fields (secrets)
   * that GET never returns.
   */
  inSync?: (props: P, observed: O, olds: P | undefined) => boolean;
  /**
   * Whether an immutable, non-path field changed. The entity keeps its
   * path, so the old one is deleted before the new one is created.
   */
  replaceOn?: (news: P, olds: P | undefined, output: A) => boolean;
  /** Attributes of the observed entity. */
  toAttrs: (subscriptionId: string, key: K, observed: O) => A;
  /** Built-in/system entities are never owned. */
  isSystem?: (observed: O) => boolean;
  /** Provisioning state for entities that converge asynchronously (202). */
  stateOf?: (observed: O) => string | undefined;
  /**
   * Delete only resets the entity to its default (singleton settings);
   * skip waiting for it to disappear.
   */
  resetOnDelete?: boolean;
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
 * Lifecycle operations (diff/read/reconcile/delete/list) for an API
 * Management child entity. Spread into `Provider.succeed(Resource, ...)`.
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
    // Child entities live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [] as A[];
    }),

    diff: Effect.fn(function* ({
      id,
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
      const key = yield* spec.keyOf(news, id, output);
      if (keysDiffer(key, spec.keyOfAttrs(output))) {
        return { action: "replace" } as const;
      }
      if (spec.replaceOn?.(news, olds, output)) {
        return { action: "replace", deleteFirst: true } as const;
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
      const attrs = spec.toAttrs(subscriptionId, key, observed);
      const owned =
        !(spec.isSystem?.(observed) ?? false) &&
        (yield* isParentOwned(
          subscriptionId,
          key.resourceGroup,
          key.serviceName,
        ));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({
      id,
      news,
      olds,
      output,
    }: {
      id: string;
      news: P;
      olds: P | undefined;
      output: A | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const key = yield* spec.keyOf(news, id, output);

      // Observe, then create or converge with one upsert when anything differs.
      const observed = yield* get(subscriptionId, key);
      const inSync =
        observed !== undefined && (spec.inSync?.(news, observed, olds) ?? true);
      if (!inSync) {
        yield* spec.put(subscriptionId, key, news);
      }
      const current = yield* waitForProvisioned(
        spec.label(key),
        get(subscriptionId, key),
        spec.stateOf ?? (() => undefined),
        { interval: "2 seconds", times: 30 },
      );
      return spec.toAttrs(subscriptionId, key, current);
    }),

    delete: Effect.fn(function* ({ output }: { output: A }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const key = spec.keyOfAttrs(output);
      if (spec.remove === undefined) return;
      yield* ignoreNotFound(spec.remove(subscriptionId, key));
      if (!spec.resetOnDelete) {
        yield* waitUntilGone(spec.label(key), get(subscriptionId, key), {
          interval: "2 seconds",
          times: 30,
        });
      }
    }),
  };
};

/** Whether an observed policy document matches the desired one. */
export const policyInSync = (
  desired: { value: string; format?: string },
  observed: { properties?: { value?: string } } | undefined,
) =>
  !(desired.format ?? "xml").endsWith("-link") &&
  observed?.properties?.value !== undefined &&
  normalizePolicy(observed.properties.value) === normalizePolicy(desired.value);

/** ARM resource ID of an entity under the API Management service. */
export const serviceEntityId = (
  subscriptionId: string,
  key: EntityKey,
  path: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${key.resourceGroup}/providers/Microsoft.ApiManagement/service/${key.serviceName}/${path}`;

/** Plain value of a possibly-redacted secret. */
export const reveal = (
  value: string | Redacted.Redacted<string> | undefined,
) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

/** Whether two maps of (possibly redacted) secrets hold the same values. */
export const sameSecrets = (
  a: Record<string, string | Redacted.Redacted<string>> | undefined,
  b: Record<string, string | Redacted.Redacted<string>> | undefined,
) => {
  const left = Object.entries(a ?? {});
  return (
    left.length === Object.keys(b ?? {}).length &&
    left.every(([key, value]) => reveal(value) === reveal(b?.[key]))
  );
};
