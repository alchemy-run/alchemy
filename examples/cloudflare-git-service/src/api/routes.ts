/**
 * The app's own routes. Each is an `alchemy/Http` route class, like the
 * engine's: an `HttpApiEndpoint` that also names the tag of its
 * implementation.
 */
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Session, Unauthorized, User } from "./auth.ts";
import { Authenticated } from "./middleware.ts";

/** Who am I. Signed-in only. */
export class Me extends Http.get<Me>()("me", "/api/v1/me", {
  success: User,
  error: Unauthorized,
  middleware: [Authenticated],
}) {}

export const MeLive = Me.make(
  Effect.succeed(() =>
    Effect.gen(function* () {
      const { user } = yield* Session;
      if (user === null) return yield* new Unauthorized();
      return user;
    }),
  ),
);

export class AppRoutes extends HttpApiGroup.make("app").add(Me) {}
