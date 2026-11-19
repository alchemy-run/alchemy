/**
 * An entity declared inline that answers with a Config value its
 * Construction phase read: a deploy that changes the value gives the pool's
 * Worker a new version, which an idle object moves to on its next call.
 */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Default } from "./cluster.ts";

const Generations = Entity.make("Generation", [Rpc.make("Get", { success: Schema.String })]);

export default class Generation extends Cluster.Entity<Generation>()(
  Generations,
  { main: import.meta.url },
  Effect.gen(function* () {
    const generation = yield* Config.String("CLUSTER_GENERATION");
    return Effect.gen(function* () {
      return Generations.of({ Get: () => Effect.succeed(generation) });
    });
  }).pipe(Effect.provide(Default)),
) {}
