/** Git's native Effect HTTP contracts, group registration, and server assembly. */
import * as Git from "@/Git/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { HASH_ROUTE } from "@/Git/Hasher/Protocol.ts";

const oid = "a".repeat(40) as Git.Oid;
const unexpected = () => Effect.die("Unexpected handler invocation");
const echoBody = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const bytes = yield* request.arrayBuffer.pipe(Effect.orDie);
    return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
      contentType: "application/x-git-upload-pack-result",
    });
  });

// The actual ApiLive registers every group against these handler implementations.
const FakeHandlers = Layer.succeed(Git.Handlers, {
  repos: {
    create: unexpected,
    get: ({ params }) => Effect.fail(new Git.RepoNotFound(params)),
    update: unexpected,
    list: unexpected,
    delete: unexpected,
    fork: unexpected,
    compact: unexpected,
    import: unexpected,
  },
  refs: {
    list: unexpected,
    get: ({ query }) => Effect.succeed(new Git.Ref({ name: query.name, oid })),
    update: unexpected,
    remove: unexpected,
  },
  objects: {
    commit: unexpected,
    log: unexpected,
    tree: unexpected,
    blob: unexpected,
    diff: unexpected,
    compare: unexpected,
    blobRaw: unexpected,
    file: unexpected,
  },
  pulls: {
    create: unexpected,
    list: unexpected,
    get: unexpected,
    update: unexpected,
    merge: unexpected,
  },
  protocol: {
    infoRefs: unexpected,
    uploadPack: echoBody,
    receivePack: echoBody,
  },
  github: {
    user: () =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ login: "default" })),
    repo: unexpected,
    branches: unexpected,
    commits: unexpected,
    commit: unexpected,
    contents: unexpected,
    pulls: unexpected,
    createPull: unexpected,
    pull: unexpected,
    updatePull: unexpected,
    mergePull: unexpected,
    pullFiles: unexpected,
  },
  internal: { hashPart: echoBody },
});

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}
class Auth extends HttpApiMiddleware.Service<
  Auth,
  { requires: RuntimeContext }
>()("test/GitHttp/Auth", {
  error: Unauthorized,
}) {}
const AuthLive = Layer.succeed(Auth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== "Bearer test")
      return yield* new Unauthorized();
    const runtime = yield* RuntimeContext;
    return HttpServerResponse.setHeader(
      yield* httpEffect,
      "x-runtime-id",
      runtime.id,
    );
  }),
);
class AppApi extends Git.Api.middleware(Auth) {}
const AppApiLive = HttpApiBuilder.group(AppApi, "github", (h) =>
  Effect.map(Git.Handlers, (git) =>
    h.handleAll({
      ...git.github,
      user: () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ login: "application" })),
    }),
  ),
);
const OpenServer = Git.Server.layer(Git.Api).pipe(Layer.provide(FakeHandlers));
const ProtectedServer = Git.Server.layer(AppApi, AppApiLive).pipe(
  Layer.provide(AuthLive),
  Layer.provide(FakeHandlers),
);

class AppRoutes extends HttpApiGroup.make("app").add(
  HttpApiEndpoint.get("health", "/health", { success: Schema.String }),
) {}
class PrefixedApi extends HttpApi.make("custom-git")
  .add(Git.Refs)
  .prefix("/git")
  .add(AppRoutes)
  .middleware(Auth) {}
const HealthLive = HttpApiBuilder.group(PrefixedApi, "app", (h) =>
  h.handle("health", () => Effect.succeed("ok")),
);
const PrefixedLive = Git.Server.layer(PrefixedApi, HealthLive);
const PrefixedServer = PrefixedLive.pipe(
  Layer.provide(AuthLive),
  Layer.provide(FakeHandlers),
);

// Check that automatic defaults preserve middleware and missing-group requirements.
const checked: Layer.Layer<Git.Server, never, Git.Handlers | Auth> =
  PrefixedLive;
// @ts-expect-error Auth must still be provided.
const missingAuth: Layer.Layer<Git.Server, never, Git.Handlers> = PrefixedLive;
// @ts-expect-error Application endpoints still need a native group implementation.
const missingApp: Layer.Layer<Git.Server, never, Git.Handlers | Auth> =
  Git.Server.layer(PrefixedApi);
void checked;
void missingAuth;
void missingApp;

const request = (server: Git.ServerShape, path: string, init?: RequestInit) =>
  server.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`http://git.test${path}`, init)),
    ),
    Effect.provideService(RuntimeContext, {
      Type: "test",
      id: "request-runtime",
      env: {},
      get: () => Effect.succeed(undefined),
      set: () => Effect.succeed(""),
    }),
    Effect.catchCause((cause) =>
      HttpServerError.causeResponse(cause).pipe(
        Effect.map(([response]) => response),
      ),
    ),
    Effect.map(HttpServerResponse.toWeb),
    Effect.scoped,
  );

describe("Git HTTP composition", () => {
  it.effect(
    "registers every default group and preserves decoded requests and typed errors",
    () =>
      Effect.gen(function* () {
        const server = yield* Git.Server;
        const ref = yield* request(
          server,
          "/api/v1/repos/acme/repo/ref?name=refs%2Fheads%2Fmain",
        );
        expect(ref.status).toBe(200);
        expect(yield* Effect.promise(() => ref.json())).toEqual({
          name: "refs/heads/main",
          oid,
        });

        const missing = yield* request(server, "/api/v1/repos/acme/missing");
        expect(missing.status).toBe(404);
        expect(yield* Effect.promise(() => missing.json())).toMatchObject({
          _tag: "RepoNotFound",
          owner: "acme",
          repo: "missing",
        });

        const invalid = yield* request(server, "/api/v1/repos/acme/repo/ref");
        expect(invalid.status).toBe(400);
      }).pipe(Effect.provide(OpenServer), Effect.scoped),
  );

  it.effect("preserves binary protocol responses", () =>
    Effect.gen(function* () {
      const server = yield* Git.Server;
      const bytes = new Uint8Array([0, 255, 1, 128, 10]);
      const response = yield* request(
        server,
        "/acme/repo.git/git-upload-pack",
        { method: "POST", body: bytes },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/x-git-upload-pack-result",
      );
      expect(
        new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
      ).toEqual(bytes);
    }).pipe(Effect.provide(OpenServer), Effect.scoped),
  );

  it.effect(
    "applies app middleware and handler overrides while keeping internal routes separate",
    () =>
      Effect.gen(function* () {
        const server = yield* Git.Server;
        const denied = yield* request(server, "/api/v3/user");
        expect(denied.status).toBe(401);
        const wireDenied = yield* request(
          server,
          "/acme/repo.git/git-upload-pack",
          { method: "POST" },
        );
        expect(wireDenied.status).toBe(401);
        const allowed = yield* request(server, "/api/v3/user", {
          headers: { authorization: "Bearer test" },
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("x-runtime-id")).toBe("request-runtime");
        expect(yield* Effect.promise(() => allowed.json())).toEqual({
          login: "application",
        });
        const internal = yield* request(server, HASH_ROUTE, {
          method: "POST",
          body: "hash input",
        });
        expect(internal.status).toBe(200);
        expect(yield* Effect.promise(() => internal.text())).toBe("hash input");
      }).pipe(Effect.provide(ProtectedServer), Effect.scoped),
  );
  it.effect(
    "adds app endpoints beside prefixed Git defaults on a subset API",
    () =>
      Effect.gen(function* () {
        const server = yield* Git.Server;
        const init = { headers: { authorization: "Bearer test" } };
        const denied = yield* request(
          server,
          "/git/api/v1/repos/acme/repo/ref?name=refs/heads/main",
        );
        expect(denied.status).toBe(401);
        const ref = yield* request(
          server,
          "/git/api/v1/repos/acme/repo/ref?name=refs/heads/main",
          init,
        );
        expect(ref.status).toBe(200);
        expect(yield* Effect.promise(() => ref.json())).toEqual({
          name: "refs/heads/main",
          oid,
        });
        expect(ref.headers.get("x-runtime-id")).toBe("request-runtime");
        const health = yield* request(server, "/health", init);
        expect(health.status).toBe(200);
        expect(yield* Effect.promise(() => health.json())).toBe("ok");
        const unprefixed = yield* request(
          server,
          "/api/v1/repos/acme/repo/ref?name=refs/heads/main",
          init,
        );
        expect(unprefixed.status).toBe(404);
      }).pipe(Effect.provide(PrefixedServer), Effect.scoped),
  );
});
