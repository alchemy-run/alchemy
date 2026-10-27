import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { CurrentUser } from "./CurrentUser.context.ts";
import { Session, Unauthorized } from "./Session.middleware.ts";
import { UserId } from "./User.id.ts";
import { VerifySession } from "./VerifySession.ts";

/** The cookie yielded's HTTP routes set on sign-in. */
export const SESSION_COOKIE = "__Host-effect-auth-session";

/** The {@link Session} middleware: the user yielded signed in, or Unauthorized. */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const verify = yield* VerifySession;
    return (effect, { headers }) =>
      Effect.gen(function* () {
        const credential = Option.flatMap(Headers.get(headers, "cookie"), (cookie) =>
          Option.fromNullishOr(Cookies.parseHeader(cookie)[SESSION_COOKIE]),
        );
        if (Option.isNone(credential)) return yield* new Unauthorized();
        const session = yield* verify(Redacted.make(credential.value)).pipe(
          Effect.catch((error) =>
            error._tag === "SessionInvalid" ? Effect.fail(new Unauthorized()) : Effect.die(error),
          ),
        );
        return yield* effect.pipe(
          Effect.provideService(CurrentUser, {
            userId: UserId.make(session.subjectId),
            name: session.claims.displayName,
          }),
        );
      });
  }),
);
