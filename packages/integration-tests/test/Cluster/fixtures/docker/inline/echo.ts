/** An entity declared inline: the class callers `yield*` is its implementation. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Default } from "../cluster.ts";

const Echoes = Entity.make("Echo", [
  Rpc.make("Say", { payload: { text: Schema.String }, success: Schema.String }),
]);

export default class Echo extends Cluster.Entity<Echo>()(
  Echoes,
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      return Echoes.of({
        Say: ({ payload }) => Effect.succeed(`echo ${payload.text}`),
      });
    });
  }).pipe(Effect.provide(Default)),
) {}
