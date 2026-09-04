/**
 * The git host, embedded in the app's own API.
 *
 * The engine holds no credentials. Better Auth decides who is calling:
 * browsers carry a session, `git` clients carry an API key in the password
 * field of the remote. One implementation of `Git.Authenticated` resolves
 * both and every git route runs behind it: REST, the wire, the raw reads,
 * and the GitHub facade. `Git.PolicyOwners` decides what a principal may
 * do to a repository.
 */
import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import { apiKey } from "@better-auth/api-key";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as Http from "alchemy/Http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

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

/**
 * Who is calling. An API key in the password field of the remote names a
 * user; otherwise the session cookie does; otherwise the request is
 * anonymous, which the policy confines to public reads. The same resolver
 * serves every git route.
 */
export const AuthenticatedLive = Git.Authenticated.make(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return Effect.gen(function* () {
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
        .pipe(Effect.catchTag("BetterAuthApiError", () => Effect.succeed(null)));
      return session
        ? { id: session.user.id, name: session.user.name }
        : undefined;
    });
  }),
);

/** The app's own route: who am I. Signed-in only. */
export class Me extends Http.get<Me>()("me", "/api/v1/me", {
  success: Git.PrincipalSchema,
  error: Git.Unauthorized,
  middleware: [Git.Authenticated],
}) {}

export const MeLive = Me.make(
  Effect.succeed(() =>
    Effect.gen(function* () {
      const { principal } = yield* Git.Caller;
      if (principal === undefined) return yield* new Git.Unauthorized();
      return principal;
    }),
  ),
);

export class AppRoutes extends HttpApiGroup.make("app").add(Me) {}

/** The git API plus ours. */
export class AppApi extends Git.Api.add(AppRoutes) {}

/** The blocks. Each line is a decision; the Repo DO needs the four below it. */
const GitLive = Git.ReposDurableObject.pipe(
  Layer.provideMerge(Git.RegistryDurableObject), // owner/name → repo
  Layer.provideMerge(Git.HasherInline), // push verification in this Worker
  Layer.provideMerge(Git.BlobStoreR2(GitObjects)), // packs, bundles, large pushes
  Layer.provideMerge(Git.PolicyOwners), // owners write, anyone reads public
);

/** The app's HTTP surface: auth routes, the API, and the git planes. */
export class App extends Context.Service<
  App,
  { readonly fetch: Effect.Effect<any, any, any> }
>()("app/App") {}

export const AppLive = Layer.effect(
  App,
  Effect.gen(function* () {
    const auth = yield* Auth;

    const api = yield* HttpApiBuilder.layer(AppApi).pipe(
      Layer.provide(Http.handlers(AppApi)), // every route, under its middleware
      Layer.provide(MeLive), // ours
      Layer.provide(Git.Handlers), // the engine's defaults for the rest
      Layer.provide(AuthenticatedLive),
      Layer.provide(Http.Platform),
      HttpRouter.toHttpEffect,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/auth")) return yield* auth.fetch;
        return yield* api;
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
