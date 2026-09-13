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
const AppApiLive = Layer.mergeAll(
  HttpApiBuilder.group(AppApi, "repos", (h) =>
    Effect.map(Git.Handlers, (git) => h.handleAll(git.repos)),
  ),
  HttpApiBuilder.group(AppApi, "refs", (h) =>
    Effect.map(Git.Handlers, (git) => h.handleAll(git.refs)),
  ),
  HttpApiBuilder.group(AppApi, "objects", (h) =>
    Effect.map(Git.Handlers, (git) => h.handleAll(git.objects)),
  ),
  HttpApiBuilder.group(AppApi, "pulls", (h) =>
    Effect.map(Git.Handlers, (git) => h.handleAll(git.pulls)),
  ),
  HttpApiBuilder.group(AppApi, "protocol", (h) =>
    Effect.map(Git.Handlers, (git) => h.handleAll(git.protocol)),
  ),
  HttpApiBuilder.group(AppApi, "github", (h) =>
    Effect.map(Git.Handlers, (git) =>
      h.handleAll({
        ...git.github,
        user: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ login: "application" }),
          ),
      }),
    ),
  ),
);
const OpenServer = Git.Server.layer(Git.Api, Git.ApiLive).pipe(
  Layer.provide(FakeHandlers),
);
const ProtectedServer = Git.Server.layer(AppApi, AppApiLive).pipe(
  Layer.provide(AuthLive),
  Layer.provide(FakeHandlers),
);

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
});
