/**
 * The git host, embedded in the app's own API.
 *
 * The engine holds no credentials. Better Auth decides who is calling:
 * browsers carry a session, `git` clients carry an API key in the password
 * field of the remote. The git groups are mounted in this Worker's
 * `HttpApi` behind the `Session` middleware next to the app's own
 * endpoints, the wire routes authenticate through `Git.Authenticate`, and
 * `Git.PolicyOwners` decides what a principal may do to a repository.
 */
import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import { apiKey } from "@better-auth/api-key";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as Path from "effect/Path";

/** Packs, clone bundles, and spilled pushes. */
export const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // `bun test` sets NODE_ENV=test: the integration test tears the stack
  // down with repositories still in the bucket.
  forceDestroy: process.env.NODE_ENV === "test",
});
/** Better Auth's users, sessions, and API keys. */
export const AuthDb = Cloudflare.D1.Database("AuthDb");

/**
 * Browsers and API clients: a Better Auth session, resolved once per
 * request and handed to every REST handler as `Git.Caller`. No session is
 * anonymous, which the policy confines to public reads.
 */
export class Session extends HttpApiMiddleware.Service<
  Session,
  { provides: Git.Caller }
>()("app/Session", { error: Git.Unauthorized }) {}

/** The app's own group: who am I. Signed-in only. */
const Me = HttpApiGroup.make("me").add(
  HttpApiEndpoint.get("whoami", "/api/v1/me", {
    success: Git.PrincipalSchema,
    error: Git.Unauthorized,
  }),
);

/** The git groups plus ours, every endpoint behind the session. */
export const AppApi = Git.Api.add(Me).middleware(Session);

// Workers have no filesystem; `HttpApiBuilder.layer` still wants a platform.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

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
    const auth = yield* BetterAuth({
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      plugins: [apiKey()],
    });

    // A session cookie or bearer session token → the caller.
    const SessionLive = Layer.succeed(Session, (httpEffect) =>
      auth.getSession().pipe(
        Effect.catchTag("BetterAuthApiError", () => Effect.succeed(null)),
        Effect.flatMap((session) =>
          Effect.provideService(httpEffect, Git.Caller, {
            principal: session
              ? { id: session.user.id, name: session.user.name }
              : undefined,
          }),
        ),
        Effect.provide(RuntimeContext.phantom),
      ),
    );

    // git clients: an API key as the password of the remote (Basic), or a
    // bearer token for `gh api`. Anything else is anonymous.
    const AuthenticateLive = Layer.succeed(
      Git.Authenticate,
      Effect.fn(function* (headers) {
        const key = Git.parseSecret(headers);
        if (key === undefined || key === "") return undefined;
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
      }),
    );

    const MeLive = HttpApiBuilder.group(AppApi, "me", (handlers) =>
      handlers.handle("whoami", () =>
        Effect.gen(function* () {
          const { principal } = yield* Git.Caller;
          if (principal === undefined) return yield* new Git.Unauthorized();
          return principal;
        }),
      ),
    );

    const api = yield* HttpApiBuilder.layer(AppApi).pipe(
      Layer.provide(Git.handlers(AppApi).pipe(Layer.provide(SessionLive))),
      Layer.provide(MeLive.pipe(Layer.provide(SessionLive))),
      Layer.merge(Git.ProtocolApi), // /:owner/:repo.git/* — a git client can only send Basic
      Layer.merge(Git.RawApi), // raw blob and file reads
      Layer.merge(Git.GitHubApi), // /api/v3, for gh and Octokit
      Layer.provide(AuthenticateLive),
      Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
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
