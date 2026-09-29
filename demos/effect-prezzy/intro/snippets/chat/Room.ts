import * as Cloudflare from "alchemy/Cloudflare";
import { Queues } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Messages } from "./Messages.ts";

// #region show
export default class Room extends Cloudflare.DurableObject<Room>()(
  "Room",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // #region archive
    const archive = yield* Queues.WriteQueue(yield* Messages);
    // #endregion archive

    return Effect.gen(function* () {
      return {
        // #region connect
        fetch: Effect.gen(function* () {
          const [response] = yield* Cloudflare.upgrade();
          return response;
        }),
        // #endregion connect
        // #region message
        webSocketMessage: Effect.fn(function* (_from, text) {
          // #region broadcast
          for (const socket of yield* state.getWebSockets()) {
            yield* socket.send(text);
          }
          // #endregion broadcast
          // #region send
          yield* archive.send({ room: state.id.name!, text })/*hide*/.pipe(Effect.orDie)/*end*/;
          // #endregion send
        }),
        // #endregion message
      };
    });
  })/*hide*/.pipe(Effect.provide(Queues.WriteQueueBinding))/*end*/,
) {}
// #endregion show
