/**
 * Who may call what. One `HttpApi` middleware in front of every route,
 * git's and ours: REST, the wire, the raw reads, and the GitHub facade.
 * A user owns the repositories under their own name; anyone may read a
 * public one.
 */
import type { RuntimeContext } from "alchemy";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import { Auth, Session, Unauthorized } from "./auth.ts";

/** The middleware in front of every route. Provides {@link Session}. */
export class Authenticated extends HttpApiMiddleware.Service<
  Authenticated,
  { provides: Session; requires: RuntimeContext }
>()("app/Authenticated", { error: Unauthorized }) {}

/** A 401 that makes `git` ask for credentials. */
const unauthorized = HttpServerResponse.jsonUnsafe(
  { _tag: "Unauthorized" },
  { status: 401, headers: { "www-authenticate": 'Basic realm="git"' } },
);

/**
 * An API key in the password field of the remote names a user; otherwise
 * the session cookie does; otherwise the request is anonymous. A user may
 * do anything under their own owner name and use the routes that have no
 * owner (create, list, import); anyone may read a public repository.
 */
export const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.gen(function* () {
    const auth = yield* Auth;
    const registry = yield* Git.RegistryStore;

    const resolve = Effect.gen(function* () {
      const { password } = yield* HttpApiBuilder.securityDecode(
        HttpApiSecurity.basic,
      );
      const key = Redacted.value(password);
      if (key !== "") {
        const verified = yield* auth.api
          .verifyApiKey({ body: { key } })
          .pipe(
            Effect.catchTag("BetterAuthApiError", () =>
              Effect.succeed({ valid: false as const, key: null }),
            ),
          );
        return verified.valid && verified.key
          ? { id: verified.key.referenceId }
          : undefined;
      }
      const session = yield* auth
        .getSession()
        .pipe(
          Effect.catchTag("BetterAuthApiError", () => Effect.succeed(null)),
        );
      return session
        ? { id: session.user.id, name: session.user.name }
        : undefined;
    });

    /**
     * Anonymous may read one public repository. A repository that does
     * not exist is the route's 404, so a 401 never confirms a private one.
     */
    const publicRead = Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const owner = params.owner?.toLowerCase();
      const name = params.repo?.toLowerCase().replace(/\.git$/, "");
      if (owner === undefined || name === undefined) return false;
      const entry = yield* registry
        .resolve(owner, name)
        .pipe(Effect.catchTag("StoreError", () => Effect.succeed(undefined)));
      return entry === undefined || entry.public;
    });

    return (httpEffect, { endpoint }) =>
      Effect.gen(function* () {
        const user = yield* resolve;
        const { owner } = yield* HttpRouter.params;
        const own =
          owner === undefined || owner.toLowerCase() === user?.id.toLowerCase();
        if (user !== undefined && own) {
          return yield* Effect.provideService(httpEffect, Session, { user });
        }
        const request = yield* HttpServerRequest;
        if (Git.isRead(endpoint, request) && (yield* publicRead)) {
          return yield* Effect.provideService(httpEffect, Session, {
            user: user ?? null,
          });
        }
        return unauthorized;
      });
  }),
);
