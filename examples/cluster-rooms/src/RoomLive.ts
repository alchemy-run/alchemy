import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { AuthLive, CurrentUser } from "./Auth.ts";
import { Default } from "./Cluster.ts";
import { Room } from "./Room.ts";

export default Room.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const members = yield* Ref.make(new Set<string>());
      return Room.of({
        Join: () =>
          Effect.gen(function* () {
            const user = yield* CurrentUser;
            return yield* Ref.modify(members, (all) => {
              const next = new Set(all).add(user.name);
              return [next.size, next];
            });
          }),
        Admit: ({ payload }) =>
          Ref.modify(members, (all) => {
            const next = new Set(all).add(payload.name);
            return [next.size, next];
          }),
      });
    });
  }).pipe(Effect.provide(Default.pipe(Layer.provide(AuthLive)))),
);
