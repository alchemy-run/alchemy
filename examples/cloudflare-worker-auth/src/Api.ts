import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AuthToken } from "./AuthToken.ts";

/**
 * A Worker with a single bearer-token protected route, mirroring the auth
 * check in `@alchemy.run/pr-package`.
 *
 * `Cloudflare.SecretsStore.ReadSecret(...)` resolves to `Redacted<string>`. The comparison
 * MUST unwrap it with `Redacted.value(expected)` — coercing a `Redacted` to a
 * string yields the literal `"<redacted>"`, so `Bearer ${expected}` would
 * compare against `"Bearer <redacted>"` and silently accept the wrong token.
 * See https://github.com/alchemy-run/alchemy-effect/pull/598.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const authToken = yield* Cloudflare.SecretsStore.ReadSecret(AuthToken);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/protected")) {
          const authHeader = request.headers.authorization;
          const expected = yield* authToken;
          if (
            !authHeader ||
            authHeader !== `Bearer ${Redacted.value(expected)}`
          ) {
            return HttpServerResponse.text("unauthorized", { status: 401 });
          }
          return HttpServerResponse.text("ok");
        }

        return HttpServerResponse.text("public");
      }).pipe(
        Effect.catchTag("SecretError", (err) =>
          Effect.succeed(
            HttpServerResponse.text(`failed to read secret: ${err.message}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.SecretsStore.ReadSecretBinding)),
) {}
