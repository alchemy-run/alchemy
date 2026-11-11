import * as warmPools from "@distilled.cloud/daytona/warm_pools";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { declarable } from "./internal/Declared.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";

/** A snapshot, by name. Accepts a `Daytona.Snapshot` or `{ name }`. */
export type WarmPoolSnapshot = { readonly name: string };

export interface WarmPoolProps {
  /** Snapshot whose sandboxes are kept warm. Changing it replaces the pool. */
  snapshot: Ref<WarmPoolSnapshot>;
  /** How many started sandboxes to keep ready. Updated in place. */
  size: number;
  /** Region to keep them in. Changing it replaces the pool. */
  target?: string;
}

export interface WarmPoolAttributes {
  /** Warm pool ID. */
  warmPoolId: string;
  /** Snapshot name. */
  snapshot: string;
  /** Region. */
  target: string;
  /** Desired pool size. */
  size: number;
  /** Sandboxes currently ready in the pool. */
  currentSize: number;
}

export type WarmPool = Resource<
  "Daytona.WarmPool",
  WarmPoolProps,
  WarmPoolAttributes,
  never,
  Providers
>;

/**
 * Keeps started sandboxes of a {@link Snapshot} ready, so creating a
 * sandbox from that snapshot hands one over instead of booting a new one.
 * Daytona uses the pool automatically for matching creates.
 *
 * Deleting the snapshot deletes its warm pools. Daytona Cloud doesn't
 * serve warm pools to every organization; where it doesn't, deploying one
 * fails with `WarmPoolsUnavailable`.
 * @see https://www.daytona.io/docs/en/warm-pools/
 *
 * ### Keeping Sandboxes Warm
 * **Example:** Four ready sandboxes of a snapshot
 * ```typescript
 * export const Pool = Daytona.WarmPool("Pool", { snapshot: Base, size: 4 });
 * ```
 *
 * @resource
 * @product Warm Pool
 */
export const WarmPool = declarable<WarmPool>()(Resource<WarmPool>("Daytona.WarmPool"));

const toAttributes = (p: warmPools.WarmPool): WarmPoolAttributes => ({
  warmPoolId: p.id,
  snapshot: p.snapshot,
  target: p.target,
  size: p.pool,
  currentSize: p.currentSize,
});

const snapshotName = (snapshot: WarmPoolProps["snapshot"]) =>
  Effect.succeed(resolved(snapshot).name);

export const WarmPoolProvider = () =>
  Provider.effect(
    WarmPool,
    Effect.succeed({
      stables: ["warmPoolId", "snapshot", "target"],
      list: Effect.fn(function* () {
        // Organizations Daytona doesn't serve warm pools to have none.
        const pools = yield* warmPools
          .listWarmPools({})
          .pipe(Effect.catchTag("WarmPoolsUnavailable", () => Effect.succeed([])));
        return pools.map(toAttributes);
      }),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const snapshot = yield* snapshotName(news.snapshot);
        if (
          snapshot !== output.snapshot ||
          (news.target !== undefined && news.target !== output.target)
        ) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        const found = (yield* warmPools.listWarmPools({})).find((p) => p.id === output.warmPoolId);
        return found ? toAttributes(found) : undefined;
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const snapshot = yield* snapshotName(news.snapshot);
        // Observe — a pool is identified by its snapshot and region.
        const pools = yield* warmPools.listWarmPools({});
        const current =
          pools.find((p) => p.id === output?.warmPoolId) ??
          pools.find(
            (p) =>
              p.snapshot === snapshot && (news.target === undefined || p.target === news.target),
          );
        // Ensure
        if (current === undefined) {
          return toAttributes(
            yield* warmPools.createWarmPool({ snapshot, pool: news.size, target: news.target }),
          );
        }
        // Sync size
        if (current.pool === news.size) return toAttributes(current);
        return toAttributes(yield* warmPools.updateWarmPool({ id: current.id, pool: news.size }));
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* warmPools
          .deleteWarmPool({ id: output.warmPoolId })
          .pipe(Effect.catchTag("WarmPoolNotFound", () => Effect.void));
      }),
    }),
  );
