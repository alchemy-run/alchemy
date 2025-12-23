import * as Effect from "effect/Effect";
import { Session } from "./opencode.ts";

export const branch = <A, Err, Req>(
  title: string,
  effect: Effect.Effect<A, Err, Req>,
) =>
  Effect.gen(function* () {
    return yield* effect.pipe(
      Effect.provide(Session.from(yield* (yield* Session).branch(title))),
    );
  });
