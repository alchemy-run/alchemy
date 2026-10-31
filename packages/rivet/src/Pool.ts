import * as Rivet from "@distilled.cloud/rivet";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { withConnection, type ConnectionProps } from "./internal/Connection.ts";

export interface PoolProps extends ConnectionProps {
  /** The namespace the pool belongs to. */
  namespace: string;
  /**
   * Pool name: a DNS label of 1 to 63 lowercase letters, digits and hyphens.
   * Nodes join the pool by this name.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Drain nodes running an older version when a newer version connects.
   * @default false
   */
  drainOnVersionUpgrade?: boolean;
  /**
   * Seconds to wait before evicting actors from a draining node.
   * @default 0
   */
  actorEvictionDelay?: number;
  /**
   * Seconds over which actors are evicted from a draining node.
   * @default 0
   */
  actorEvictionPeriod?: number;
  /**
   * Rate at which actors are evicted from a draining node.
   * @default 1
   */
  actorEvictionRate?: number;
}

export interface PoolAttributes {
  /** The pool name nodes join with. */
  name: string;
  /** The namespace the pool belongs to. */
  namespace: string;
  /** The control plane the pool lives on. */
  endpoint: string;
  drainOnVersionUpgrade: boolean;
  actorEvictionDelay: number;
  actorEvictionPeriod: number;
  actorEvictionRate: number;
  /** The Durable Object classes the pool's nodes host, sorted by name. */
  durableObjects: PoolDurableObject[];
  /** Environment values the hosted classes need, merged. */
  env: Record<string, unknown>;
}

/** A Durable Object class a pool's nodes are built with. */
export interface PoolDurableObject {
  /** The actor name: the class's logical id. */
  name: string;
  /** The module that exports the class. */
  module: string;
  /** The export of {@link module} that holds it. */
  handler: string;
}

/** Data the Durable Objects a pool hosts bind onto it. */
export interface PoolBindingContract {
  durableObjects?: PoolDurableObject[];
  env?: Record<string, unknown>;
}

export interface Pool extends Resource<
  "Rivet.Pool",
  PoolProps,
  PoolAttributes,
  PoolBindingContract
> {}

/**
 * A node pool on a Rivet control plane. Nodes that connect with the pool's
 * name host its actors; the control plane rejects nodes whose pool does not
 * exist. Pool Layers (`RivetDocker.Pool`, …) create one for the nodes they
 * run, so declare one directly only for nodes Alchemy does not deploy.
 *
 * ### Creating a pool
 * **Example:** A pool in a namespace
 * ```typescript
 * const pool = yield* Rivet.Pool("Nodes", {
 *   endpoint: "https://rivet.example.com",
 *   token: Redacted.make(adminToken),
 *   namespace: namespace.name,
 * });
 * ```
 *
 * ### Draining on upgrade
 * **Example:** Move actors off old nodes when a new version connects
 * ```typescript
 * const pool = yield* Rivet.Pool("Nodes", {
 *   endpoint: "https://rivet.example.com",
 *   token: Redacted.make(adminToken),
 *   namespace: namespace.name,
 *   drainOnVersionUpgrade: true,
 *   actorEvictionPeriod: 60,
 * });
 * ```
 *
 * @resource
 */
export const Pool = Resource<Pool>("Rivet.Pool");

/** The pool still has nodes connected after they were given time to drain. */
export class PoolStillConnected extends Data.TaggedError("Rivet.PoolStillConnected")<{
  readonly message: string;
}> {}

/** A pool create returned success but the pool cannot be read back. */
export class PoolVanished extends Data.TaggedError("Rivet.PoolVanished")<{
  readonly message: string;
}> {}

const poolName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: 63, delimiter: "-" });

/** Ownership tags ride in the pool's free-form `metadata`. */
const tagsOf = (pool: Rivet.pools.Pool): Record<string, string> | undefined => {
  const metadata = pool.metadata as { tags?: unknown } | null | undefined;
  const tags = metadata?.tags;
  return typeof tags === "object" && tags !== null ? (tags as Record<string, string>) : undefined;
};

/** Merge what each hosted class bound: one entry per class, sorted for stable bundles. */
const hostedOf = (
  bindings: ReadonlyArray<PoolBindingContract>,
): Pick<PoolAttributes, "durableObjects" | "env"> => {
  const durableObjects = new Map<string, PoolDurableObject>();
  const env: Record<string, unknown> = {};
  for (const binding of bindings) {
    for (const object of binding.durableObjects ?? []) durableObjects.set(object.name, object);
    Object.assign(env, binding.env);
  }
  return {
    durableObjects: [...durableObjects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    env,
  };
};

export const PoolProvider = () =>
  Provider.effect(
    Pool,
    Effect.gen(function* () {
      const observe = (connection: ConnectionProps, namespace: string, name: string) =>
        Rivet.pools.getPool({ pool: name, namespace }).pipe(
          Effect.map((res) => res.pool),
          Effect.catchTag(["PoolNotFound", "NamespaceNotFound"], () => Effect.undefined),
          withConnection(connection),
        );

      const toAttrs = (
        connection: ConnectionProps,
        namespace: string,
        pool: Rivet.pools.Pool,
        hosted: Pick<PoolAttributes, "durableObjects" | "env">,
      ): PoolAttributes => ({
        ...hosted,
        name: pool.name,
        namespace,
        endpoint: connection.endpoint,
        drainOnVersionUpgrade: pool.drain_on_version_upgrade,
        actorEvictionDelay: pool.actor_eviction_delay,
        actorEvictionPeriod: pool.actor_eviction_period,
        actorEvictionRate: pool.actor_eviction_rate,
      });

      return {
        stables: ["name", "namespace", "endpoint"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* poolName(id, olds?.name));
          if ((yield* poolName(id, news.name)) !== name) {
            return { action: "replace" } as const;
          }
          if (
            news.namespace !== (output?.namespace ?? olds?.namespace) ||
            news.endpoint !== (output?.endpoint ?? olds?.endpoint)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* poolName(id, olds?.name));
          const namespace = output?.namespace ?? olds.namespace;
          const pool = yield* observe(olds, namespace, name);
          if (pool === undefined) return undefined;
          const attrs = toAttrs(olds, namespace, pool, {
            durableObjects: output?.durableObjects ?? [],
            env: output?.env ?? {},
          });
          const tags = yield* createInternalTags(id);
          return hasTags(tags, tagsOf(pool)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
          const name = output?.name ?? (yield* poolName(id, news.name));
          const hosted = hostedOf(bindings.map((binding) => binding.data));
          const tags = yield* createInternalTags(id);
          const desired = {
            drain_on_version_upgrade: news.drainOnVersionUpgrade ?? false,
            actor_eviction_delay: news.actorEvictionDelay ?? 0,
            actor_eviction_period: news.actorEvictionPeriod ?? 0,
            actor_eviction_rate: news.actorEvictionRate ?? 1,
          };

          // Observe
          const observed = yield* observe(news, news.namespace, name);

          // Ensure + sync: `upsertPool` is a full PUT, so call it only when
          // the pool is missing or a setting (or its ownership tags) drifted.
          const inSync =
            observed !== undefined &&
            observed.drain_on_version_upgrade === desired.drain_on_version_upgrade &&
            observed.actor_eviction_delay === desired.actor_eviction_delay &&
            observed.actor_eviction_period === desired.actor_eviction_period &&
            observed.actor_eviction_rate === desired.actor_eviction_rate &&
            hasTags(tags, tagsOf(observed));
          if (inSync) return toAttrs(news, news.namespace, observed, hosted);

          yield* session.note(
            observed === undefined ? `Creating pool ${name}...` : `Updating pool ${name}...`,
          );
          yield* Rivet.pools
            .upsertPool({
              pool: name,
              namespace: news.namespace,
              ...desired,
              metadata: { tags: { ...tagsOf(observed ?? ({} as Rivet.pools.Pool)), ...tags } },
            })
            .pipe(withConnection(news));

          const pool = yield* observe(news, news.namespace, name);
          if (pool === undefined) {
            return yield* new PoolVanished({ message: `Rivet pool ${name} vanished after upsert` });
          }
          return toAttrs(news, news.namespace, pool, hosted);
        }),
        delete: Effect.fn(function* ({ output, olds, session }) {
          // A pool's nodes are stopped before the pool is deleted, but the
          // control plane only drops them once they disconnect: retry while
          // they drain.
          yield* Rivet.pools.deletePool({ pool: output.name, namespace: output.namespace }).pipe(
            Effect.tapError((error) =>
              error._tag === "PoolNodesConnected"
                ? session.note(`Waiting for pool ${output.name}'s nodes to disconnect...`)
                : Effect.void,
            ),
            Effect.retry({
              while: (error) => error._tag === "PoolNodesConnected",
              schedule: Schedule.spaced("5 seconds"),
              times: 12,
            }),
            Effect.catchTag(["PoolNotFound", "NamespaceNotFound"], () => Effect.void),
            Effect.catchTag("PoolNodesConnected", () =>
              Effect.fail(
                new PoolStillConnected({
                  message: `Rivet pool ${output.name} still has connected nodes after 60s`,
                }),
              ),
            ),
            withConnection(olds),
          );
        }),
      };
    }),
  );
