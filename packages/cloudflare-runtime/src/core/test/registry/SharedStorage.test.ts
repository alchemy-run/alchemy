// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's shared storage tests
 * (`workers-sdk/packages/miniflare/test/storage-owner.spec.ts`).
 *
 * A Miniflare instance maps to an "instance" here: a separately built
 * runtime layer (its own registry watcher, loopback server and runtimes) over
 * the same runtime home (so the same dev registry) and the same storage
 * directory, the way two `alchemy dev` processes would share them. Within
 * one instance every `Runtime.start` is a separate workerd process too,
 * which is how `alchemy dev` runs a stack's Workers (issue #1872).
 *
 * Upstream cases intentionally not ported:
 * - "requires persistence and a dev registry": shared storage is on by
 *   default here and needs no configuration; it applies whenever storage is
 *   disk-backed and the runtime has a registry proxy.
 * - The R2 public bucket URL (`/cdn-cgi/local/r2/public`): this runtime has
 *   no public bucket endpoint.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as D1 from "../../bindings/d1/index.ts";
import * as Images from "../../bindings/images/index.ts";
import * as KvNamespace from "../../bindings/kv-namespace/index.ts";
import * as R2Bucket from "../../bindings/r2-bucket/index.ts";
import * as SecretsStore from "../../bindings/secrets-store/index.ts";
import * as Stream from "../../bindings/stream/index.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import type { BindingHook } from "../../PluginContext.ts";
import * as Registry from "../../registry/Registry.ts";
import * as RegistryProxy from "../../registry/RegistryProxy.ts";
import { storageCandidateName } from "../../registry/RegistryTypes.shared.ts";
import { SharedStorageEnabled } from "../../registry/SharedStorage.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import { type TestWorker, startTestWorker } from "../helpers/runtime.ts";

const compatibilityDate = "2026-03-10";

// -----------------------------------------------------------------------------
// Instances
// -----------------------------------------------------------------------------

interface InstanceOptions {
  /** Runtime home; instances sharing it share the dev registry. */
  readonly home: string;
  /** Storage directory; instances sharing it share local resources. */
  readonly storage: string;
  /** Turn shared storage off (`SharedStorageEnabled`). */
  readonly disabled?: boolean;
}

const instanceLayer = (options: InstanceOptions) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(RuntimeServices.layerLocalBindings()),
    Layer.provideMerge(RuntimeServices.layerProxy()),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(RuntimeServices.layerLoopback()),
    Layer.provideMerge(Storage.layerDisk(options.storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(RegistryProxy.RegistryProxyLive),
    Layer.provideMerge(Registry.RegistryLive),
    Layer.provideMerge(Paths.PathsLive),
    Layer.provideMerge(Docker.DockerLive),
    Layer.provideMerge(Workerd.WorkerdLive),
    Layer.provide(options.disabled ? Layer.succeed(SharedStorageEnabled, false) : Layer.empty),
    Layer.provide(
      ConfigProvider.layer(
        Effect.succeed(ConfigProvider.fromUnknown({ CLOUDFLARE_RUNTIME_HOME: options.home })),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto),
    ),
  );

interface Instance {
  /** Start a Worker in a workerd process of its own. */
  readonly start: (
    name: string,
    script: string,
    bindings: ReadonlyArray<BindingHook<any>>,
  ) => Effect.Effect<TestWorker>;
  /** Stop every runtime of the instance (Miniflare's `dispose()`). */
  readonly dispose: Effect.Effect<void>;
}

/**
 * Build an instance with a memo map of its own, so it shares nothing with
 * other instances but the runtime home and storage directory.
 */
const makeInstance = Effect.fn(function* (options: InstanceOptions) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithMemoMap(
    instanceLayer(options),
    Layer.makeMemoMapUnsafe(),
    scope,
  );
  return {
    start: (name, script, bindings) =>
      startTestWorker({
        name,
        compatibilityDate,
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: script }],
        bindings: [...bindings],
      }).pipe(
        Effect.provide(context),
        Scope.provide(scope),
        Effect.orDie,
      ) as Effect.Effect<TestWorker>,
    dispose: Scope.close(scope, Exit.void),
  } satisfies Instance;
});

const tempDirectory = Effect.fn(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});

/** A runtime home and storage directory for instances to share. */
const sharedDirectories = Effect.gen(function* () {
  return {
    home: yield* tempDirectory("shared-storage-home-"),
    storage: yield* tempDirectory("shared-storage-"),
  };
});

/** Retry a check until the storage owner has changed hands. */
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    // Requests in flight on the old owner may be reset (a defect here).
    Effect.catchCause((cause) => Effect.fail(cause)),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
  );

const text = (worker: TestWorker, path: string, init?: RequestInit) =>
  worker
    .fetch(path, init)
    .pipe(
      Effect.flatMap((response) =>
        Effect.promise(async () => ({ status: response.status, body: await response.text() })),
      ),
    );

const json = <T>(worker: TestWorker, path: string, init?: RequestInit) =>
  worker
    .fetch(path, init)
    .pipe(Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<T>)));

const put = (body: string) => ({ method: "PUT", body });

// -----------------------------------------------------------------------------
// Upstream cases
// -----------------------------------------------------------------------------

const KV_WORKER = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "k";
    if (request.method === "PUT") {
      await env.NS.put(key, await request.text());
      return new Response("ok");
    }
    const value = await env.NS.get(key);
    return new Response(value ?? "<null>");
  },
};
`;

const R2_D1_WORKER = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    if (kind === "r2") {
      if (request.method === "PUT") {
        await env.BUCKET.put("obj", await request.text());
        return new Response("ok");
      }
      const object = await env.BUCKET.get("obj");
      return new Response(object ? await object.text() : "<null>");
    }
    if (request.method === "PUT") {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS t(v TEXT)").run();
      await env.DB.prepare("INSERT INTO t(v) VALUES (?)").bind(await request.text()).run();
      return new Response("ok");
    }
    const { results } = await env.DB.prepare("SELECT v FROM t").all();
    return new Response(JSON.stringify(results.map((row) => row.v)));
  },
};
`;

const COUNT_WORKER = `
export default {
  async fetch(request, env) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS t(v TEXT)").run();
    if (request.method === "PUT") {
      await env.DB.prepare("INSERT INTO t(v) VALUES (?)").bind(await request.text()).run();
    }
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM t").first();
    return new Response(String(row.c));
  },
};
`;

describe("shared storage", () => {
  it.live(
    "routes a client's KV through the owner so storage is shared",
    () =>
      Effect.gen(function* () {
        const dirs = yield* sharedDirectories;
        const owner = yield* (yield* makeInstance(dirs)).start("worker", KV_WORKER, [
          KvNamespace.local({ binding: "NS", id: "NS" }),
        ]);
        const client = yield* (yield* makeInstance(dirs)).start("worker-client", KV_WORKER, [
          KvNamespace.local({ binding: "NS", id: "NS" }),
        ]);

        // Write through the client (which routes to the owner).
        expect((yield* text(client, "/?key=greeting", put("hello-from-client"))).body).toBe("ok");
        // The owner can read what the client wrote, so storage is shared.
        expect((yield* text(owner, "/?key=greeting")).body).toBe("hello-from-client");
        // And the client can read it back through the proxy.
        expect((yield* text(client, "/?key=greeting")).body).toBe("hello-from-client");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "an owner hosts plugins absent from its own bindings",
    () =>
      Effect.gen(function* () {
        const dirs = yield* sharedDirectories;
        yield* (yield* makeInstance(dirs)).start(
          "owner",
          "export default { fetch() { return new Response('owner'); } }",
          [KvNamespace.local({ binding: "NS", id: "NS" })],
        );
        const client = yield* (yield* makeInstance(dirs)).start(
          "client",
          `export default {
            async fetch(request, env) {
              await env.DB.prepare("CREATE TABLE IF NOT EXISTS t(v TEXT)").run();
              return new Response("ok");
            }
          }`,
          [D1.local({ binding: "DB", id: "DB" })],
        );
        expect(yield* text(client, "/")).toEqual({ status: 200, body: "ok" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "routes a client's R2 and D1 through the owner so storage is shared",
    () =>
      Effect.gen(function* () {
        const dirs = yield* sharedDirectories;
        const bindings = [
          R2Bucket.local({ binding: "BUCKET", id: "BUCKET" }),
          D1.local({ binding: "DB", id: "DB" }),
        ];
        const owner = yield* (yield* makeInstance(dirs)).start("worker", R2_D1_WORKER, bindings);
        const client = yield* (yield* makeInstance(dirs)).start(
          "worker-client",
          R2_D1_WORKER,
          bindings,
        );

        // R2: client write → owner read.
        expect((yield* text(client, "/?kind=r2", put("r2-from-client"))).body).toBe("ok");
        expect((yield* text(owner, "/?kind=r2")).body).toBe("r2-from-client");

        // D1: client write → owner read.
        expect((yield* text(client, "/?kind=d1", put("d1-from-client"))).body).toBe("ok");
        expect((yield* text(owner, "/?kind=d1")).body).toBe(JSON.stringify(["d1-from-client"]));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "routes a client's Stream through the owner over RPC so storage is shared",
    () =>
      Effect.gen(function* () {
        // Exercises the JSRPC path of the owner boundary (native RPC over the
        // debug port), including nested RPC targets (`videos.list()`).
        const STREAM_WORKER = `
          export default {
            async fetch(request, env) {
              try {
                const url = new URL(request.url);
                if (url.pathname === "/video") {
                  const video = env.STREAM.video(url.searchParams.get("id"));
                  return Response.json({
                    details: await video.details(),
                    captions: await video.captions.list(),
                    downloads: await video.downloads.get(),
                  });
                }
                if (url.pathname === "/watermark") {
                  const id = url.searchParams.get("id");
                  if (request.method === "POST") {
                    const body = new Response(new Uint8Array([0, 1, 2, 3])).body;
                    return Response.json(await env.STREAM.watermarks.generate(body, { name: "shared" }));
                  }
                  if (request.method === "DELETE" && id !== null) {
                    await env.STREAM.watermarks.delete(id);
                    return Response.json({ count: (await env.STREAM.watermarks.list()).length });
                  }
                  return Response.json(id === null
                    ? { count: (await env.STREAM.watermarks.list()).length }
                    : await env.STREAM.watermarks.get(id));
                }
                if (request.method === "PUT") {
                  const body = new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])).body;
                  return Response.json(await env.STREAM.upload(body, {}));
                }
                const videos = await env.STREAM.videos.list();
                return Response.json({ count: videos.length, preview: videos[0]?.preview });
              } catch (e) {
                return Response.json({ error: String((e && e.stack) || e) }, { status: 500 });
              }
            }
          }
        `;
        const dirs = yield* sharedDirectories;
        const ownerInstance = yield* makeInstance(dirs);
        yield* ownerInstance.start("worker", STREAM_WORKER, [Stream.local({ binding: "STREAM" })]);
        const client = yield* (yield* makeInstance(dirs)).start("worker-client", STREAM_WORKER, [
          Stream.local({ binding: "STREAM" }),
        ]);

        // Client uploads a video (RPC through the owner)...
        const uploaded = yield* json<{ id: string; preview: string }>(client, "/", {
          method: "PUT",
        });
        expect(uploaded.id).toBeTruthy();

        // ...and resolves the nested `videos` RPC target through the owner too.
        expect(yield* json(client, "/")).toEqual({ count: 1, preview: uploaded.preview });
        expect(yield* json(client, `/video?id=${uploaded.id}`)).toEqual({
          details: uploaded,
          captions: [],
          downloads: {},
        });

        const watermark = yield* json<{ id: string; name: string }>(client, "/watermark", {
          method: "POST",
        });
        expect(watermark.name).toBe("shared");
        expect(yield* json(client, `/watermark?id=${watermark.id}`)).toMatchObject(watermark);
        expect(yield* json(client, "/watermark")).toEqual({ count: 1 });
        expect(yield* json(client, `/watermark?id=${watermark.id}`, { method: "DELETE" })).toEqual({
          count: 0,
        });

        const video = yield* Effect.promise(() => fetch(uploaded.preview));
        expect(video.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => video.arrayBuffer()))).toEqual(
          new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
        );

        // The client takes over the stored videos when the owner stops.
        yield* ownerInstance.dispose;
        const failedOver = yield* eventually(
          json<{ count?: number; preview?: string }>(client, "/").pipe(
            Effect.filterOrFail((result) => result.count === 1 && result.preview !== undefined),
          ),
        );
        const failedOverVideo = yield* Effect.promise(() => fetch(failedOver.preview!));
        expect(failedOverVideo.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => failedOverVideo.arrayBuffer()))).toEqual(
          new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90_000 },
  );

  it.live(
    "serves Stream previews from an owner without a Stream binding",
    () =>
      Effect.gen(function* () {
        const UPLOAD_WORKER = `
          export default {
            async fetch(request, env) {
              const body = new Response(new Uint8Array([7, 6, 5, 4])).body;
              return Response.json(await env.STREAM.upload(body, {}));
            }
          }
        `;
        const dirs = yield* sharedDirectories;
        // The owner only binds KV, but hosts the Stream simulator, which
        // builds preview URLs from the owner's entry.
        yield* (yield* makeInstance(dirs)).start("worker", KV_WORKER, [
          KvNamespace.local({ binding: "NS", id: "NS" }),
        ]);
        const client = yield* (yield* makeInstance(dirs)).start("worker-client", UPLOAD_WORKER, [
          Stream.local({ binding: "STREAM" }),
        ]);

        const uploaded = yield* json<{ preview: string }>(client, "/", { method: "PUT" });
        const video = yield* Effect.promise(() => fetch(uploaded.preview));
        expect(video.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => video.arrayBuffer()))).toEqual(
          new Uint8Array([7, 6, 5, 4]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "routes a client's Secrets Store secret through the owner",
    () =>
      Effect.gen(function* () {
        const SECRET_WORKER = `
          export default {
            async fetch(request, env) {
              if (request.method === "PUT") {
                await env.ADMIN.put("api_key", await request.text());
                return new Response("ok");
              }
              try {
                return new Response(await env.SECRET.get());
              } catch (e) {
                return new Response(e.message, { status: 404 });
              }
            }
          }
        `;
        const bindings = [
          SecretsStore.local({ binding: "SECRET", storeId: "store_a", secretName: "api_key" }),
          SecretsStore.admin({ binding: "ADMIN", storeId: "store_a" }),
        ];
        const dirs = yield* sharedDirectories;
        const owner = yield* (yield* makeInstance(dirs)).start("worker", SECRET_WORKER, bindings);
        const client = yield* (yield* makeInstance(dirs)).start(
          "worker-client",
          SECRET_WORKER,
          bindings,
        );

        // Seed the secret value on the owner (which holds the local store)...
        expect((yield* text(owner, "/", put("super-secret"))).body).toBe("ok");
        // ...and the client reads it back over the routed binding.
        expect(yield* text(client, "/")).toEqual({ status: 200, body: "super-secret" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "routes a client's Images store to the owner",
    () =>
      Effect.gen(function* () {
        const IMAGES_WORKER = `
          export default {
            async fetch(request, env) {
              if (request.method === "PUT") {
                return Response.json(await env.IMAGES.hosted.upload(
                  await request.arrayBuffer(),
                  { id: "shared-image" }
                ));
              }
              const stream = await env.IMAGES.hosted.image("shared-image").bytes();
              return new Response(stream, { status: stream === null ? 404 : 200 });
            }
          }
        `;
        const dirs = yield* sharedDirectories;
        const owner = yield* (yield* makeInstance(dirs)).start("worker", IMAGES_WORKER, [
          Images.local({ binding: "IMAGES" }),
        ]);
        const client = yield* (yield* makeInstance(dirs)).start("worker-client", IMAGES_WORKER, [
          Images.local({ binding: "IMAGES" }),
        ]);

        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        const upload = yield* client.fetch("/", { method: "PUT", body: bytes });
        yield* Effect.promise(() => upload.json());
        expect(upload.status).toBe(200);

        const fromOwner = yield* owner.fetch("/");
        expect(new Uint8Array(yield* Effect.promise(() => fromOwner.arrayBuffer()))).toEqual(bytes);
        const delivery = yield* client.fetch("/__cf_local/imagedelivery/shared-image/public");
        expect(delivery.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => delivery.arrayBuffer()))).toEqual(bytes);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "hosts plugins and resources not used by the instance that owns them",
    () =>
      Effect.gen(function* () {
        const dirs = yield* sharedDirectories;
        yield* (yield* makeInstance(dirs)).start(
          "first",
          "export default { fetch() { return new Response('first'); } }",
          [KvNamespace.local({ binding: "NS", id: "NS" })],
        );
        const second = yield* (yield* makeInstance(dirs)).start(
          "second",
          `export default {
            async fetch(request, env) {
              const url = new URL(request.url);
              if (url.pathname === "/secret") {
                if (request.method === "PUT") {
                  await env.ADMIN.put("later-secret", await request.text());
                  return new Response("ok");
                }
                return new Response(await env.SECRET.get());
              }
              if (request.method === "PUT") {
                await env.DB.prepare("CREATE TABLE IF NOT EXISTS t(v TEXT)").run();
                await env.DB.prepare("INSERT INTO t(v) VALUES (?)").bind(await request.text()).run();
                return new Response("ok");
              }
              const row = await env.DB.prepare("SELECT v FROM t").first();
              return new Response(row?.v ?? "<null>");
            }
          }`,
          [
            D1.local({ binding: "DB", id: "later-db" }),
            SecretsStore.local({
              binding: "SECRET",
              storeId: "later-store",
              secretName: "later-secret",
            }),
            SecretsStore.admin({ binding: "ADMIN", storeId: "later-store" }),
          ],
        );

        expect((yield* text(second, "/", put("from-second"))).body).toBe("ok");
        expect((yield* text(second, "/")).body).toBe("from-second");
        expect((yield* text(second, "/secret", put("secret-from-second"))).body).toBe("ok");
        expect((yield* text(second, "/secret")).body).toBe("secret-from-second");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "lets many client instances write one D1 concurrently without contention",
    () =>
      Effect.gen(function* () {
        // The scenario that produces cross-process SQLITE_BUSY without a
        // shared owner: many processes opening the same SQLite file. With an
        // owner, only it opens the file, so concurrent writes all succeed.
        const N = 10; // client instances
        const M = 10; // inserts per client
        const WORKER = `
          export default {
            async fetch(request, env) {
              const url = new URL(request.url);
              if (url.searchParams.get("init") === "1") {
                await env.DB.prepare("CREATE TABLE IF NOT EXISTS t(v INTEGER)").run();
                return new Response("ok");
              }
              if (request.method === "PUT") {
                await env.DB.prepare("INSERT INTO t(v) VALUES (1)").run();
                return new Response("ok");
              }
              const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM t").first();
              return new Response(String(row.c));
            }
          }
        `;
        const dirs = yield* sharedDirectories;
        const clients = yield* Effect.forEach(
          Array.from({ length: N }, (_, index) => index),
          (index) =>
            makeInstance(dirs).pipe(
              Effect.flatMap((instance) =>
                instance.start(`worker-${index}`, WORKER, [D1.local({ binding: "DB", id: "DB" })]),
              ),
            ),
          { concurrency: "unbounded" },
        );

        // Create the table once, then hammer it concurrently from every client.
        expect((yield* text(clients[0], "/?init=1")).body).toBe("ok");
        const statuses = yield* Effect.forEach(
          clients.flatMap((client) => Array.from({ length: M }, () => client)),
          (client) => text(client, "/", { method: "PUT" }).pipe(Effect.map((r) => r.status)),
          { concurrency: "unbounded" },
        );
        // No request failed (e.g. with a 500 from SQLITE_BUSY)...
        expect(statuses.every((status) => status === 200)).toBe(true);
        // ...and every write landed.
        expect((yield* text(clients[0], "/")).body).toBe(String(N * M));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  );

  it.live(
    "hands storage ownership to another live instance",
    () =>
      Effect.gen(function* () {
        const dirs = yield* sharedDirectories;
        const first = yield* makeInstance(dirs);
        yield* first.start("worker", COUNT_WORKER, [D1.local({ binding: "DB", id: "DB" })]);
        const second = yield* (yield* makeInstance(dirs)).start("worker-second", COUNT_WORKER, [
          D1.local({ binding: "DB", id: "DB" }),
        ]);

        expect((yield* text(second, "/", put("before"))).body).toBe("1");

        yield* first.dispose;
        expect(
          yield* eventually(
            text(second, "/").pipe(
              Effect.filterOrFail((result) => result.status === 200 && result.body === "1"),
            ),
          ),
        ).toEqual({ status: 200, body: "1" });
        expect((yield* text(second, "/", put("after"))).body).toBe("2");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90_000 },
  );

  it.live(
    "elects independent owners for different storage directories",
    () =>
      Effect.gen(function* () {
        const home = yield* tempDirectory("shared-storage-home-");
        const instances = yield* Effect.forEach(["first", "second"], (name) =>
          Effect.gen(function* () {
            const storage = yield* tempDirectory("shared-storage-");
            return yield* (yield* makeInstance({ home, storage })).start(name, COUNT_WORKER, [
              D1.local({ binding: "DB", id: "DB" }),
            ]);
          }),
        );
        for (const instance of instances) {
          expect((yield* text(instance, "/", put("value"))).body).toBe("1");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "persists a Worker's cache across restarts",
    () =>
      Effect.gen(function* () {
        const CACHE_WORKER = `
          export default {
            async fetch(request) {
              const key = new Request("http://cache/key");
              if (request.method === "PUT") {
                await caches.default.put(
                  key,
                  new Response(await request.text(), {
                    headers: { "Cache-Control": "max-age=3600" },
                  }),
                );
                return new Response("ok");
              }
              return (await caches.default.match(key)) ?? new Response("missing");
            }
          }
        `;
        const dirs = yield* sharedDirectories;
        // A shared binding makes the runtime a storage candidate.
        const bindings = [KvNamespace.local({ binding: "NS", id: "NS" })];
        const first = yield* makeInstance(dirs);
        const worker = yield* first.start("worker", CACHE_WORKER, bindings);
        expect((yield* text(worker, "/", put("persisted"))).body).toBe("ok");
        expect((yield* text(worker, "/")).body).toBe("persisted");
        yield* first.dispose;

        const restarted = yield* (yield* makeInstance(dirs)).start(
          "worker",
          CACHE_WORKER,
          bindings,
        );
        expect((yield* text(restarted, "/")).body).toBe("persisted");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );

  it.live(
    "keeps storage local when sharing is disabled",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dirs = yield* sharedDirectories;
        const worker = yield* (yield* makeInstance({ ...dirs, disabled: true })).start(
          "worker",
          KV_WORKER,
          [KvNamespace.local({ binding: "NS", id: "NS" })],
        );
        expect((yield* text(worker, "/?key=k", put("plain"))).body).toBe("ok");
        expect((yield* text(worker, "/?key=k")).body).toBe("plain");
        // No storage candidate was registered.
        const registry = path.join(dirs.home, ".local", "state", "alchemy", "registry");
        const entries = yield* fs
          .readDirectory(registry)
          .pipe(Effect.orElseSucceed(() => [] as Array<string>));
        expect(
          entries.filter((entry) => decodeURIComponent(entry).startsWith(storageCandidateName(""))),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );
});

// -----------------------------------------------------------------------------
// Alchemy cases
// -----------------------------------------------------------------------------

describe("shared storage within one runtime layer", () => {
  it.live(
    "lets Workers in separate workerd processes write shared storage concurrently",
    () =>
      Effect.gen(function* () {
        // `alchemy dev` runs each Worker in a workerd of its own over one
        // storage directory (issue #1872): before shared storage, about a
        // third of these writes failed with SQLITE_BUSY.
        const N = 200;
        const WORKER = `
          export default {
            async fetch(request, env) {
              const url = new URL(request.url);
              const who = url.searchParams.get("who");
              const kind = url.searchParams.get("kind");
              if (kind === "count") {
                const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM t").first();
                const listed = await env.BUCKET.list({ limit: 1000 });
                return Response.json({ rows: row.c, objects: listed.objects.length });
              }
              if (kind === "d1") {
                await env.DB.prepare("CREATE TABLE IF NOT EXISTS t (who TEXT, n INTEGER)").run();
              }
              const errors = [];
              await Promise.all(Array.from({ length: ${N} }, (_, n) => (
                kind === "d1" ? env.DB.prepare("INSERT INTO t VALUES (?, ?)").bind(who, n).run()
                : kind === "d1-read" ? env.DB.prepare("SELECT 1").all()
                : kind === "r2" ? env.BUCKET.put(who + "/" + n, "x".repeat(64))
                : env.KV.put(who + "/" + n, "x")
              ).catch((e) => { errors.push(String(e)); })));
              return Response.json({ errors: errors.length, first: errors[0] });
            }
          }
        `;
        const dirs = yield* sharedDirectories;
        const instance = yield* makeInstance(dirs);
        const bindings = [
          D1.local({ binding: "DB", id: "shared" }),
          R2Bucket.local({ binding: "BUCKET", id: "shared" }),
          KvNamespace.local({ binding: "KV", id: "shared" }),
        ];
        const [a, b] = yield* Effect.all(
          [
            instance.start("worker-a", WORKER, bindings),
            instance.start("worker-b", WORKER, bindings),
          ],
          { concurrency: "unbounded" },
        );
        for (const kind of ["d1", "d1-read", "r2", "kv"]) {
          const results = yield* Effect.all(
            [
              json<{ errors: number; first?: string }>(a, `/?who=a&kind=${kind}`),
              json<{ errors: number; first?: string }>(b, `/?who=b&kind=${kind}`),
            ],
            { concurrency: "unbounded" },
          );
          expect(results, kind).toEqual([{ errors: 0 }, { errors: 0 }]);
        }
        expect(yield* json(a, "/?kind=count")).toEqual({ rows: 2 * N, objects: 2 * N });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90_000 },
  );
});
