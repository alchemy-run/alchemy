import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { PoolHost } from "./internal/PoolHostService.ts";
import type { Providers } from "./Providers.ts";

/**
 * A pool Layer, as every host's pool returns it: provide it to an
 * implementation to deploy it to that pool.
 */
export type PoolLayer<R = never> = Layer.Layer<PoolHost, never, R>;

/** An entity class a pool is built with. */
export interface PoolEntity {
  /** The entity type: the class's logical id. */
  name: string;
  /** The module that exports the class. */
  module: string;
  /** The export of {@link module} that holds it. */
  handler: string;
  /**
   * An existing Effect Cluster program that hosts the entity, run as it is:
   * an external `Cluster.Entity`. It owns every runner in its set.
   */
  program?: string;
}

/** Data the entities a pool hosts bind onto it. */
export interface PoolBindingContract {
  entities?: PoolEntity[];
  env?: Record<string, unknown>;
}

export interface PoolProps {
  /** The pool's name, used in its service names. */
  name: string;
}

export interface PoolAttributes {
  /** The pool's name. */
  name: string;
  /** The entity classes the pool hosts, sorted by type. */
  entities: PoolEntity[];
  /** Environment values the hosted classes need, merged. */
  env: Record<string, unknown>;
}

export interface Pool extends Resource<
  "Cluster.Pool",
  PoolProps,
  PoolAttributes,
  PoolBindingContract,
  Providers
> {}

/**
 * The set of entity classes one pool hosts, collected from the
 * entities that were given it. Pool Layers (`ClusterDocker.SwarmPool`,
 * …) declare one and build their program from it; it owns nothing in the
 * cloud.
 *
 * @internal
 */
export const Pool = Resource<Pool>("Cluster.Pool");

/**
 * A pool was given an external `Cluster.Entity` and something
 * else hosted another way: an external program owns every runner it runs on.
 */
export class PoolProgramConflict extends Data.TaggedError("Cluster.PoolProgramConflict")<{
  readonly message: string;
}> {}

export const PoolProvider = () =>
  Provider.succeed(Pool, {
    stables: ["name"],
    reconcile: ({ id, news, bindings }) =>
      Effect.gen(function* () {
        const entities = new Map<string, PoolEntity>();
        const env: Record<string, unknown> = {};
        for (const { data } of bindings) {
          for (const entity of data.entities ?? []) entities.set(entity.name, entity);
          Object.assign(env, data.env);
        }
        const all = [...entities.values()];
        const programs = new Set(all.flatMap((entity) => (entity.program ? [entity.program] : [])));
        if (programs.size > 1 || (programs.size === 1 && all.some((entity) => !entity.program))) {
          return yield* new PoolProgramConflict({
            message:
              `Runners '${id}' were given ${all.map((entity) => `'${entity.name}'`).join(", ")}, ` +
              `but an external program runs on every runner it is given: give each program ` +
              `a pool of its own, and host Alchemy entities in another pool.`,
          });
        }
        return {
          name: news.name,
          entities: [...entities.values()].sort((a, b) => a.name.localeCompare(b.name)),
          env,
        };
      }),
    delete: () => Effect.void,
  });
