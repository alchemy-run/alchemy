/** A Durable Object that keeps its messages in a Durable Stream. */
import * as Rivet from "@alchemy.run/rivet";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChatLog } from "./chat-log.ts";
import { Default, Services } from "./cluster.ts";

export default class Room extends Rivet.DurableObject<Room>()(
  "Room",
  { main: import.meta.url },
  Effect.gen(function* () {
    const log = yield* ChatLog;
    return Effect.gen(function* () {
      return {
        say: (key: string, user: string, text: string) =>
          log.append(key, { user, text }).pipe(Effect.orDie),
      };
    });
  }).pipe(Effect.provide(Layer.mergeAll(Default, Services, StreamFormat.Json))),
) {}
