/** An entity on the pool whose database is given by URL. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Default } from "./cluster.ts";

const Echoes = Entity.make("UrlEcho", [
  Rpc.make("Say", { payload: { text: Schema.String }, success: Schema.String }),
]);

export default class UrlEcho extends Cluster.Entity<UrlEcho>()(
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
