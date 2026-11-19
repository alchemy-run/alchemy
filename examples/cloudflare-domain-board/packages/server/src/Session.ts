import { ActorName } from "@board/domain/Actor";
import { CurrentActor } from "@board/domain/CurrentActor.context";
import { ACTOR_HEADER, Session, Unauthorized } from "@board/domain/Session.middleware";
import * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The board's token: everyone who holds it may act on the board, under any name. */
export class BoardToken extends Context.Service<
  BoardToken,
  Effect.Effect<Redacted.Redacted<string>>
>()("Board/BoardToken") {}

/** A random token, made once when the stage is first deployed and kept in its state. */
export const BoardTokenLive = Layer.effect(
  BoardToken,
  Effect.gen(function* () {
    const token = yield* Alchemy.Random("BoardToken");
    return yield* token.text;
  }),
);

/** Compare in constant time, so a wrong token's prefix tells nothing. */
const sameToken = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};

const bearerOf = (headers: Headers.Headers) =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) =>
    value.startsWith("Bearer ") ? Option.some(value.slice("Bearer ".length)) : Option.none(),
  );

const actorOf = (headers: Headers.Headers) =>
  Option.flatMap(Headers.get(headers, ACTOR_HEADER), Schema.decodeUnknownOption(ActorName)).pipe(
    Option.filter((name) => name.length > 0),
  );

/**
 * The {@link Session} middleware: a request with the board's token and a name
 * in `x-board-actor` acts as that name. Anything else is Unauthorized.
 *
 * One shared token keeps the example small. Per-actor tokens, or grants
 * scoped to channels, would be checked here.
 */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const token = yield* BoardToken;
    return (effect, { headers }) =>
      Effect.gen(function* () {
        const expected = Redacted.value(yield* token);
        const bearer = bearerOf(headers);
        const actor = actorOf(headers);
        if (Option.isNone(bearer) || !sameToken(bearer.value, expected) || Option.isNone(actor)) {
          return yield* new Unauthorized();
        }
        return yield* Effect.provideService(effect, CurrentActor, actor.value);
      });
  }),
);
