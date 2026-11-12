import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableDeferred } from "effect/workflow";
import { Default } from "./Cluster.ts";
import { Answer, Invite } from "./Invite.ts";
import { Room } from "./Room.ts";

export default Invite.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const rooms = yield* Room;
    return Invite.of(
      Effect.fn(function* ({ room, guest }) {
        const accepted = yield* DurableDeferred.await(Answer);
        if (!accepted) return false;
        yield* Activity.make({
          name: "admit",
          success: Schema.Int,
          execute: rooms.getByName(room).pipe(
            Effect.flatMap((target) => target.Admit({ name: guest })),
            Effect.orDie,
          ),
        });
        return true;
      }),
    );
  }).pipe(Effect.provide(Default)),
);
