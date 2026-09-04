/**
 * The git host, embedded in the app's own API.
 *
 * The engine holds no auth. Better Auth decides who is calling: browsers
 * carry a session, `git` clients carry an API key in the password field
 * of the remote. One `HttpApi` middleware resolves both and every git
 * route runs behind it: REST, the wire, the raw reads, and the GitHub
 * facade. A user owns the repositories under their own name; anyone may
 * read a public one.
 */
import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import { apiKey } from "@better-auth/api-key";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Http from "alchemy/Http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

/** Packs, clone bundles, and spilled pushes. */
export const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // `bun test` sets NODE_ENV=test: the integration test tears the stack
  // down with repositories still in the bucket.
  forceDestroy: process.env.NODE_ENV === "test",
});
/** Better Auth's users, sessions, and API keys. */
export const AuthDb = Cloudflare.D1.Database("AuthDb");

/** Better Auth: users, sessions, and API keys. Yielded wherever it is needed. */
export const Auth = BetterAuth({
  basePath: "/api/auth",
  emailAndPassword: { enabled: true },
  plugins: [apiKey()],
});

/** The user record routes see. */
export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
});

/** 401 — no usable credential, on a route that needs one. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * Who is calling: the signed-in user, or `null` on an anonymous read of
 * a public repository. Every route runs with it in context.
 */
export class Session extends Context.Service<
  Session,
  { readonly user: typeof User.Type | null }
>()("app/Session") {}

/** The middleware in front of every route, git's and ours. */
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

/** The app's own route: who am I. Signed-in only. */
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

/** The git API plus ours, every route behind the middleware. */
export class AppApi extends Git.Api.add(AppRoutes).middleware(Authenticated) {}

/** The blocks. Each line is a decision; the Repo DO needs the three below it. */
const GitLive = Git.Server.layer(AppApi).pipe(
  Layer.provide(MeLive), // ours
  Layer.provide(Git.Handlers), // the engine's routes
  Layer.provide(AuthenticatedLive),
  Layer.provide(Git.ReposDurableObject),
  Layer.provide(Git.RegistryDurableObject), // owner/name → repo
  Layer.provide(Git.HasherInline), // push verification in this Worker
  Layer.provide(Git.BlobStoreR2(GitObjects)), // packs, bundles, large pushes
);

/** The app's HTTP surface: auth routes, then the API and the git planes. */
export class App extends Context.Service<
  App,
  { readonly fetch: Effect.Effect<any, any, any> }
>()("app/App") {}

export const AppLive = Layer.effect(
  App,
  Effect.gen(function* () {
    const auth = yield* Auth;
    const git = yield* Git.Server;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/auth")) return yield* auth.fetch;
        return yield* git.fetch;
      }),
    };
  }),
).pipe(Layer.provide(GitLive), Layer.provide(CloudflareD1(AuthDb)));

export default class GitHost extends Cloudflare.Worker<GitHost>()(
  "GitHost",
  {
    main: import.meta.url,
    ...Git.GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const app = yield* App;
    return { fetch: app.fetch };
  }).pipe(Effect.provide(AppLive)),
) {}
