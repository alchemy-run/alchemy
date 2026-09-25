import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeHttp from "node:http";
import * as D1 from "../bindings/d1/D1.ts";
import * as DurableObjectNamespace from "../bindings/DurableObjectNamespace.ts";
import * as KvNamespace from "../bindings/kv-namespace/KvNamespace.ts";
import * as R2Bucket from "../bindings/r2-bucket/R2Bucket.ts";
import * as Workflows from "../bindings/workflows/Workflows.ts";
import {
  HEADER_ORIGINAL_URL,
  HEADER_PROXY_SHARED_SECRET,
} from "../globals/ProxyHeaders.shared.ts";
import {
  localRuntimeLayer,
  poll,
  startTestWorker,
  type TestWorker,
} from "./helpers/runtime.ts";

const SCRIPT = `
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

export class Store extends DurableObject {
  async fetch() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", "hello from do");
    return new Response("ok");
  }
}

export class Flow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("only-step", async () => "done");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      await env.KV.put("greeting", "hello from kv");
      await env.BUCKET.put("file.txt", "hello from r2");
      await env.DB.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
      await env.DB.prepare("INSERT INTO users (name) VALUES (?)").bind("ada").run();
      await env.STORE.get(env.STORE.idFromName("alice")).fetch("http://do/");
      return new Response("seeded");
    }
    if (url.pathname === "/kv") {
      return new Response(await env.KV.get(url.searchParams.get("key")));
    }
    return new Response("user worker");
  },
};
`;

interface Envelope<T> {
  success: boolean;
  result: T;
}

const API = "/cdn-cgi/explorer/api";

const startExplorerWorker = (
  name: string,
  options: { explorer?: boolean; proxySharedSecret?: string } = {},
) =>
  startTestWorker({
    name,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    explorer: options.explorer ?? true,
    proxySharedSecret: options.proxySharedSecret,
    modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
    durableObjectNamespaces: [{ className: "Store", sql: true }],
    workflows: [{ workflowName: `${name}-flow`, className: "Flow" }],
    bindings: [
      KvNamespace.local({ binding: "KV", id: `${name}-kv` }),
      R2Bucket.local({ binding: "BUCKET", id: `${name}-bucket` }),
      D1.local({ binding: "DB", id: `${name}-db` }),
      DurableObjectNamespace.local({ binding: "STORE", className: "Store" }),
      Workflows.local({
        binding: "FLOW",
        workflowName: `${name}-flow`,
        className: "Flow",
      }),
    ],
  });

const seed = (worker: TestWorker) =>
  worker.fetchText("/seed").pipe(
    Effect.map((text) => {
      expect(text).toBe("seeded");
    }),
  );

const api = <T>(worker: TestWorker, path: string, init?: RequestInit) =>
  worker.fetchJson<Envelope<T>>(`${API}${path}`, init).pipe(
    Effect.map((body) => {
      expect(body.success).toBe(true);
      return body.result;
    }),
  );

/** `fetch` forbids overriding `Host`, so spoof it through `node:http`. */
const statusWithHost = (worker: TestWorker, host: string) =>
  Effect.callback<number>((resume) => {
    const request = NodeHttp.get(
      new URL("/cdn-cgi/explorer/api/storage/kv/namespaces", worker.baseUrl),
      { headers: { host } },
      (response) => {
        response.resume();
        resume(Effect.succeed(response.statusCode ?? 0));
      },
    );
    request.on("error", (error) => resume(Effect.die(error)));
  });

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Local Explorer",
  (it) => {
    it.effect("serves the explorer UI", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-ui");
        const response = yield* worker.fetch("/cdn-cgi/explorer");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(
          (yield* Effect.promise(() => response.text())).toLowerCase(),
        ).toContain("<html");
      }),
    );

    it.effect("browses and edits KV namespaces", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-kv");
        yield* seed(worker);

        const namespaces = yield* api<Array<{ id: string; title: string }>>(
          worker,
          "/storage/kv/namespaces",
        );
        expect(namespaces).toContainEqual({
          id: "explorer-kv-kv",
          title: "KV",
        });

        const keys = yield* api<Array<{ name: string }>>(
          worker,
          "/storage/kv/namespaces/explorer-kv-kv/keys",
        );
        expect(keys.map((key) => key.name)).toEqual(["greeting"]);

        expect(
          yield* worker.fetchText(
            `${API}/storage/kv/namespaces/explorer-kv-kv/values/greeting`,
          ),
        ).toBe("hello from kv");

        // Writes through the explorer are visible to the worker's binding.
        const put = yield* worker.fetch(
          `${API}/storage/kv/namespaces/explorer-kv-kv/values/edited`,
          {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: "from the explorer",
          },
        );
        expect(put.status).toBe(200);
        expect(yield* worker.fetchText("/kv?key=edited")).toBe(
          "from the explorer",
        );
      }),
    );

    it.effect("browses R2 buckets", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-r2");
        yield* seed(worker);

        const { buckets } = yield* api<{ buckets: Array<{ name: string }> }>(
          worker,
          "/r2/buckets",
        );
        expect(buckets.map((bucket) => bucket.name)).toContain(
          "explorer-r2-bucket",
        );

        const objects = yield* api<Array<{ key: string }>>(
          worker,
          "/r2/buckets/explorer-r2-bucket/objects",
        );
        expect(objects.map((object) => object.key)).toEqual(["file.txt"]);

        expect(
          yield* worker.fetchText(
            `${API}/r2/buckets/explorer-r2-bucket/objects/file.txt`,
          ),
        ).toBe("hello from r2");
      }),
    );

    it.effect("queries D1 databases", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-d1");
        yield* seed(worker);

        const databases = yield* api<Array<{ uuid: string; name: string }>>(
          worker,
          "/d1/database",
        );
        expect(databases).toContainEqual(
          expect.objectContaining({ uuid: "explorer-d1-db", name: "DB" }),
        );

        const [result] = yield* api<
          Array<{
            results: { columns: Array<string>; rows: Array<Array<unknown>> };
          }>
        >(worker, "/d1/database/explorer-d1-db/raw", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: "SELECT name FROM users" }),
        });
        expect(result.results).toEqual({ columns: ["name"], rows: [["ada"]] });
      }),
    );

    it.effect("lists and queries SQLite-backed Durable Objects", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-do");
        yield* seed(worker);
        const namespaceId = "explorer-do-Store";

        const namespaces = yield* api<Array<{ id: string; class: string }>>(
          worker,
          "/workers/durable_objects/namespaces",
        );
        expect(namespaces).toContainEqual(
          expect.objectContaining({
            id: namespaceId,
            class: "Store",
            use_sqlite: true,
          }),
        );

        // Objects are discovered from `<storage>/<uniqueKey>/*.sqlite` via the
        // loopback, and named through the injected `__miniflare_getDOName`.
        const objects = yield* api<Array<{ id: string; name?: string }>>(
          worker,
          `/workers/durable_objects/namespaces/${namespaceId}/objects`,
        );
        expect(objects).toEqual([
          expect.objectContaining({ name: "alice", hasStoredData: true }),
        ]);

        const [result] = yield* api<
          Array<{ columns: Array<string>; rows: Array<Array<unknown>> }>
        >(worker, `/workers/durable_objects/namespaces/${namespaceId}/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            durable_object_name: "alice",
            queries: [{ sql: "SELECT text FROM notes" }],
          }),
        });
        expect(result.columns).toEqual(["text"]);
        expect(result.rows).toEqual([["hello from do"]]);
      }),
    );

    it.effect("creates and lists Workflow instances", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-wf");
        const workflowName = "explorer-wf-flow";

        const workflows = yield* api<
          Array<{ name: string; class_name: string }>
        >(worker, "/workflows");
        expect(workflows).toContainEqual(
          expect.objectContaining({ name: workflowName, class_name: "Flow" }),
        );

        const created = yield* worker.fetch(
          `${API}/workflows/${workflowName}/instances`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "run-1" }),
          },
        );
        expect(created.status).toBe(200);

        // Instances are discovered from the engine's on-disk storage.
        yield* poll<Envelope<Array<{ id: string; status?: string }>>>(
          worker,
          `${API}/workflows/${workflowName}/instances`,
          (body) =>
            body.result?.some((instance) => instance.id === "run-1") ?? false,
        );
      }),
    );

    it.effect("aggregates resources from other local workers", () =>
      Effect.gen(function* () {
        const first = yield* startExplorerWorker("explorer-peer-a");
        const second = yield* startExplorerWorker("explorer-peer-b");
        yield* seed(second);

        // The peer is found through the dev registry and dialed over its
        // workerd debug port (`core:entry`), so `first` lists and reads
        // `second`'s namespace.
        yield* poll<Envelope<Array<{ id: string }>>>(
          first,
          `${API}/storage/kv/namespaces`,
          (body) =>
            ["explorer-peer-a-kv", "explorer-peer-b-kv"].every((id) =>
              body.result.some((namespace) => namespace.id === id),
            ),
        );
        expect(
          yield* first.fetchText(
            `${API}/storage/kv/namespaces/explorer-peer-b-kv/values/greeting`,
          ),
        ).toBe("hello from kv");
      }),
    );

    it.effect("rejects non-localhost Host and Origin headers", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-guard");

        expect(yield* statusWithHost(worker, "evil.example")).toBe(403);
        expect(yield* statusWithHost(worker, "localhost:1234")).toBe(200);

        const crossSite = yield* worker.fetch(`${API}/storage/kv/namespaces`, {
          headers: { origin: "https://evil.example" },
        });
        expect(crossSite.status).toBe(403);
      }),
    );

    it.effect("checks the client-facing host behind a trusted proxy", () =>
      Effect.gen(function* () {
        const secret = "explorer-proxy-secret";
        const worker = yield* startExplorerWorker("explorer-proxied", {
          proxySharedSecret: secret,
        });
        // Behind the Vite proxy the raw Host is the private runtime address;
        // the guard must judge the restored client-facing URL instead.
        const viaProxy = (origin: string) =>
          worker.fetch(`${API}/storage/kv/namespaces`, {
            headers: {
              [HEADER_PROXY_SHARED_SECRET]: secret,
              [HEADER_ORIGINAL_URL]: `${origin}${API}/storage/kv/namespaces`,
            },
          });

        expect((yield* viaProxy("http://evil.example")).status).toBe(403);
        expect((yield* viaProxy("http://localhost:5173")).status).toBe(200);
      }),
    );

    it.effect("is not served unless enabled", () =>
      Effect.gen(function* () {
        const worker = yield* startExplorerWorker("explorer-off", {
          explorer: false,
        });
        expect(yield* worker.fetchText("/cdn-cgi/explorer")).toBe(
          "user worker",
        );
      }),
    );
  },
);
