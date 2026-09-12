import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { expect, test } from "vitest";
import * as Docker from "../Docker.ts";
import * as Globals from "../globals/Globals.ts";
import * as Internet from "../globals/Internet.ts";
import * as Storage from "../globals/Storage.ts";
import * as Paths from "../internal/Paths.ts";
import * as Runtime from "../Runtime.ts";
import * as RuntimeServices from "../RuntimeServices.ts";
import type { RuntimeWorker } from "../RuntimeWorker.ts";
import * as Workerd from "../workerd/Workerd.ts";
import * as KvNamespace from "../bindings/kv-namespace/KvNamespace.ts";

const runtimeLayer = (storage: string, home: string) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(RuntimeServices.layerLocalBindings()),
    Layer.provideMerge(RuntimeServices.layerProxy()),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(RuntimeServices.layerLoopback()),
    Layer.provide(Storage.layerDisk(storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(RuntimeServices.layerRegistry()),
    Layer.provide(Paths.PathsLive),
    Layer.provide(Docker.DockerLive),
    Layer.provide(Workerd.WorkerdLive),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ CLOUDFLARE_RUNTIME_HOME: home }),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
const worker = (name: string): RuntimeWorker => ({
  name,
  localExplorer: true,
  compatibilityDate: "2026-08-31",
  compatibilityFlags: [],
  bindings: [KvNamespace.local({ binding: "KV", id: name })],
  modules: [
    {
      name: "main.js",
      type: "ESModule",
      content: `export default { async fetch(request, env) { return new Response(await env.KV.get("test") ?? "app"); } };`,
    },
  ],
});
const request = (url: string | URL, init?: RequestInit) =>
  Effect.tryPromise(() =>
    fetch(url, { ...init, signal: AbortSignal.timeout(2000) }),
  );

test("elects one host during concurrent startup and isolates storage directories", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "explorer-host-race",
      });
      const lifetime = yield* Effect.scope;
      const contexts = yield* Effect.forEach(
        ["shared", "shared", "separate"],
        (storage) =>
          Layer.buildWithScope(
            runtimeLayer(`${directory}/${storage}`, `${directory}/home`),
            lifetime,
          ),
      );
      const urls = yield* Effect.forEach(
        contexts,
        (context, index) =>
          Runtime.Runtime.use((runtime) =>
            runtime.start(worker(`race-${index}`)),
          ).pipe(Effect.provideContext(context)),
        { concurrency: "unbounded" },
      );
      const locations = yield* Effect.forEach(urls, (url) =>
        request(new URL("/cdn-cgi/local/explorer/", url), {
          redirect: "manual",
        }).pipe(Effect.map((response) => response.headers.get("location"))),
      );
      expect(locations[0]).toBeTruthy();
      expect(locations[0]).toBe(locations[1]);
      expect(locations[2]).not.toBe(locations[0]);
      const isolated = locations[2];
      if (!isolated)
        return yield* Effect.fail(new Error("Missing isolated Explorer URL"));
      const response = yield* request(new URL("api/local/workers", isolated));
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        result: [{ name: "race-2" }],
      });
      expect(
        (yield* request(
          new URL("api/storage/kv/namespaces/race-0/keys", isolated),
        )).status,
      ).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}, 30_000);

test("shares one browser URL across runtimes, preserves writes, and takes over the same port", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "explorer-host-test",
      });
      const home = `${directory}/home`;
      const storage = `${directory}/storage`;
      const lifetime = yield* Effect.scope;
      const firstScope = yield* Scope.fork(lifetime);
      const secondScope = yield* Scope.fork(lifetime);
      const first = yield* Layer.buildWithScope(
        runtimeLayer(storage, home),
        firstScope,
      );
      const second = yield* Layer.buildWithScope(
        runtimeLayer(storage, home),
        secondScope,
      );
      const firstWorkerScope = yield* Scope.fork(firstScope);
      const start = (config: RuntimeWorker) =>
        Runtime.Runtime.use((runtime) => runtime.start(config));
      const one = yield* start(worker("a-first")).pipe(
        Effect.provideContext(first),
        Scope.provide(firstWorkerScope),
      );
      const two = yield* start(worker("z-second")).pipe(
        Effect.provideContext(second),
        Scope.provide(secondScope),
      );
      const route = "/cdn-cgi/local/explorer/";
      const firstRedirect = yield* request(
        new URL(`${route}kv?worker=z-second`, one),
        { redirect: "manual" },
      );
      const secondRedirect = yield* request(
        new URL(`${route}kv?worker=z-second`, two),
        { redirect: "manual" },
      );
      expect(firstRedirect.status).toBe(307);
      expect(secondRedirect.headers.get("location")).toBe(
        firstRedirect.headers.get("location"),
      );
      const location = firstRedirect.headers.get("location");
      if (!location)
        return yield* Effect.fail(new Error("Missing Explorer redirect"));
      const explorer = new URL(location);
      expect(explorer.searchParams.get("worker")).toBe("z-second");
      const api = new URL(`${route}api/`, explorer);
      const list = Effect.gen(function* () {
        const response = yield* request(new URL("local/workers", api));
        if (!response.ok)
          return yield* Effect.fail(
            new Error(`Explorer returned ${response.status}`),
          );
        return yield* Effect.promise(
          () => response.json() as Promise<{ result: { name: string }[] }>,
        );
      });
      const discovered = yield* list.pipe(
        Effect.repeat({
          while: (body) => body.result.length !== 2,
          schedule: Schedule.spaced("100 millis"),
          times: 50,
        }),
      );
      expect(discovered.result.map((entry) => entry.name).sort()).toEqual([
        "a-first",
        "z-second",
      ]);
      const form = new FormData();
      form.set("value", "shared host write");
      const write = yield* request(
        new URL("storage/kv/namespaces/z-second/values/test", api),
        { method: "PUT", body: form },
      );
      expect(write.status, yield* Effect.promise(() => write.text())).toBe(200);
      expect(yield* Effect.promise(async () => (await fetch(two)).text())).toBe(
        "shared host write",
      );
      // The first Worker's shutdown must not own the browser endpoint's lifetime.
      yield* Scope.close(firstWorkerScope, Exit.void);
      expect((yield* request(new URL(route, explorer))).status).toBe(200);
      const restarted = yield* start(worker("a-first")).pipe(
        Effect.provideContext(first),
        Scope.provide(firstScope),
      );
      expect(
        (yield* request(new URL(`${route}kv?worker=z-second`, restarted), {
          redirect: "manual",
        })).headers.get("location"),
      ).toBe(location);
      // Close the owning runtime, then check automatic failover.
      yield* Scope.close(firstScope, Exit.void);
      const afterFirst = yield* list.pipe(
        Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
      );
      expect(afterFirst.result.map((entry) => entry.name)).toContain(
        "z-second",
      );
      expect(
        (yield* request(new URL(`${route}kv?worker=z-second`, two), {
          redirect: "manual",
        })).headers.get("location"),
      ).toBe(location);
      // The endpoint still serves the original resource after host replacement.
      expect(
        yield* Effect.promise(async () =>
          (
            await fetch(
              new URL("storage/kv/namespaces/z-second/values/test", api),
            )
          ).text(),
        ),
      ).toBe("shared host write");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}, 30_000);
