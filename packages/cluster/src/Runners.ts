import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

/** An entity class a set of runners is built with. */
export interface RunnersEntity {
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

/** Data the entities a set of runners hosts bind onto it. */
export interface RunnersBindingContract {
  entities?: RunnersEntity[];
  env?: Record<string, unknown>;
}

export interface RunnersProps {
  /** The name runners are known by, used in their service names. */
  name: string;
}

export interface RunnersAttributes {
  /** The name runners are known by. */
  name: string;
  /** The entity classes the runners host, sorted by type. */
  entities: RunnersEntity[];
  /** Environment values the hosted classes need, merged. */
  env: Record<string, unknown>;
}

export interface Runners extends Resource<
  "Cluster.Runners",
  RunnersProps,
  RunnersAttributes,
  RunnersBindingContract,
  Providers
> {}

/**
 * The set of entity classes one group of runners hosts, collected from the
 * entities that were given it. Runners Layers (`ClusterDocker.Runners`,
 * …) declare one and build their program from it; it owns nothing in the
 * cloud.
 *
 * @internal
 */
export const Runners = Resource<Runners>("Cluster.Runners");

/**
 * A set of runners was given an external `Cluster.Entity` and something
 * else hosted another way: an external program owns every runner it runs on.
 */
export class RunnersProgramConflict extends Data.TaggedError("Cluster.RunnersProgramConflict")<{
  readonly message: string;
}> {}

export const RunnersProvider = () =>
  Provider.succeed(Runners, {
    stables: ["name"],
    reconcile: ({ id, news, bindings }) =>
      Effect.gen(function* () {
        const entities = new Map<string, RunnersEntity>();
        const env: Record<string, unknown> = {};
        for (const { data } of bindings) {
          for (const entity of data.entities ?? []) entities.set(entity.name, entity);
          Object.assign(env, data.env);
        }
        const all = [...entities.values()];
        const programs = new Set(all.flatMap((entity) => (entity.program ? [entity.program] : [])));
        if (programs.size > 1 || (programs.size === 1 && all.some((entity) => !entity.program))) {
          return yield* new RunnersProgramConflict({
            message:
              `Runners '${id}' were given ${all.map((entity) => `'${entity.name}'`).join(", ")}, ` +
              `but an external program runs on every runner it is given: give each program ` +
              `runners of its own, and host Alchemy entities on other runners.`,
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
