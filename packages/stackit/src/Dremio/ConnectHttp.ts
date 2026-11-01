import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { accessOf, makeLoginOf } from "./BindingHttp.ts";
import { Connect, type ConnectionInfo } from "./Connect.ts";
import { toRedacted } from "./internal.ts";
import type { User } from "./User.ts";

/**
 * HTTP implementation of {@link Connect}. Everything but the token comes from the attributes
 * of the bound user, and the token from Dremio's login.
 *
 * @layer
 * @provides Stackit.Dremio.Connect
 */
export const ConnectHttp = Layer.succeed(
  Connect,
  Effect.fn(function* (user: User) {
    const access = yield* accessOf(user);
    const catalogUrl = yield* user.catalogUrl;
    const arrowFlightUrl = yield* user.arrowFlightUrl;
    const loginOf = makeLoginOf(access);
    return Effect.gen(function* () {
      const login = yield* loginOf;
      const { token } = yield* login.credentials.pipe(Effect.provide(FetchHttpClient.layer));
      const password = yield* access.password;
      const info: ConnectionInfo = {
        uiUrl: yield* access.uiUrl,
        catalogUrl: yield* catalogUrl,
        arrowFlightUrl: yield* arrowFlightUrl,
        username: yield* access.username,
        // `loginOf` already failed for a user with no known password.
        password: toRedacted(password ?? ""),
        token,
      };
      return info;
    });
  }),
);
