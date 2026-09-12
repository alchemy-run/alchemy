import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as DurableObjectNamespace from "../bindings/DurableObjectNamespace.ts";
import * as KvNamespace from "../bindings/kv-namespace/KvNamespace.ts";
import type { RuntimeWorker } from "../RuntimeWorker.ts";
import { localRuntimeLayer, startTestWorker } from "./helpers/runtime.ts";

const API = "/cdn-cgi/local/explorer/api";
const KV_ID = "explorer:kv/with spaces";
const DO_ID = "explorer-counter";
const kv = `${API}/storage/kv/namespaces/${encodeURIComponent(KV_ID)}`;
const durable = `${API}/workers/durable_objects/namespaces/${DO_ID}`;
const script = `
import { DurableObject } from "cloudflare:workers";
class BaseCounter extends DurableObject {
  #tag = "private-field";
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (value INTEGER)");
    ctx.storage.sql.exec("INSERT INTO counter SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM counter)");
  }
  increment() {
    this.ctx.storage.sql.exec("UPDATE counter SET value = value + 1");
    return { value: this.ctx.storage.sql.exec("SELECT value FROM counter").one().value, tag: this.#tag, id: this.ctx.id.toString() };
  }
  fetch() { return Response.json(this.increment()); }
}
export class Counter extends BaseCounter {}
// Like Alchemy's bridge, the constructor returns a Proxy that binds declared
// methods to the target and dynamically resolves application RPC methods.
export class BridgeCounter extends BaseCounter {
  constructor(ctx, env) {
    super(ctx, env);
    return new Proxy(this, { get(target, prop) {
      if (prop in target) {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (prop === "dynamicIncrement") return () => target.increment();
    } });
  }
}
export class Legacy extends DurableObject {
  async fetch() {
    await this.ctx.storage.put("legacy", true);
    return new Response("legacy");
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/seed") {
      await env.RESOURCES.put("folder/a ?é", "hello KV", { metadata: { kind: "test" }, expirationTtl: 3600 });
      for (let i = 0; i < 10; i++) await env.RESOURCES.put("folder/b" + i, "second");
      await env.RESOURCES.put("outside", "other");
      return Response.json(await env.COUNTER.getByName("named-counter").increment());
    }
    if (path === "/bridge") return Response.json(await env.BRIDGE.getByName("named-bridge").dynamicIncrement());
    if (path === "/legacy") return env.LEGACY.getByName("legacy").fetch(request);
    if (path === "/counter") return env.COUNTER.getByName("named-counter").fetch(request);
    return new Response("application response");
  }
};
`;
const owner: RuntimeWorker = {
  name: "explorer-owner",
  compatibilityDate: "2026-08-31",
  compatibilityFlags: [],
  localExplorer: true,
  bindings: [
    KvNamespace.local({ binding: "RESOURCES", id: KV_ID }),
    DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" }),
    DurableObjectNamespace.local({
      binding: "BRIDGE",
      className: "BridgeCounter",
    }),
    DurableObjectNamespace.local({ binding: "LEGACY", className: "Legacy" }),
  ],
  modules: [{ name: "nested/main.js", type: "ESModule", content: script }],
  durableObjectNamespaces: [
    { className: "Counter", uniqueKey: DO_ID, sql: true },
    { className: "BridgeCounter", uniqueKey: "explorer-bridge", sql: true },
    { className: "Legacy", uniqueKey: "explorer-legacy", sql: false },
  ],
};
const query = (sql: string, id: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ durable_object_id: id, queries: [{ sql }] }),
});

layer(localRuntimeLayer)("Local Explorer", (it) => {
  it.effect(
    "browses live KV and Durable Objects through another worker and survives restart",
    () =>
      Effect.gen(function* () {
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const worker = yield* startTestWorker(owner).pipe(
          Effect.provideService(Scope.Scope, ownerScope),
        );
        const peer = yield* startTestWorker({
          name: "explorer-peer",
          localExplorer: true,
          compatibilityDate: "2026-08-31",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "COUNTER",
              className: "Counter",
              scriptName: owner.name,
              uniqueKey: DO_ID,
            }),
          ],
          modules: [
            {
              name: "peer.js",
              type: "ESModule",
              content: `export default { async fetch(request, env) { return Response.json(await env.COUNTER.getByName("named-counter").increment()); } };`,
            },
          ],
        });
        expect(yield* worker.fetchText("/")).toBe("application response");
        const seeded = yield* worker.fetchJson<{
          id: string;
          value: number;
          tag: string;
        }>("/seed");
        expect(seeded).toMatchObject({ value: 1, tag: "private-field" });
        const bridge = yield* worker.fetchJson<{ id: string; value: number }>(
          "/bridge",
        );
        expect(bridge.value).toBe(1);
        expect(yield* worker.fetchText("/legacy")).toBe("legacy");

        // The registry watcher is asynchronous; wait on the actual discovery result.
        const list = yield* peer
          .fetchJson<{ result: { id: string }[] }>(
            `${API}/storage/kv/namespaces`,
          )
          .pipe(
            Effect.repeat({
              while: (body) => !body.result.some((ns) => ns.id === KV_ID),
              schedule: Schedule.spaced("100 millis"),
              times: 50,
            }),
          );
        expect(list.result.some((ns) => ns.id === KV_ID)).toBe(true);
        const workers = yield* peer.fetchJson<{
          result: {
            name: string;
            bindings: { kv: unknown[]; do: unknown[] };
          }[];
        }>(`${API}/local/workers`);
        expect(
          workers.result.find((entry) => entry.name === owner.name)?.bindings
            .kv,
        ).toContainEqual({
          id: KV_ID,
          bindingName: "RESOURCES",
        });
        expect(
          workers.result.find((entry) => entry.name === owner.name)?.bindings
            .do,
        ).toContainEqual({
          id: DO_ID,
          bindingName: "COUNTER",
          className: "Counter",
          scriptName: owner.name,
          useSqlite: true,
        });
        const keys = yield* peer.fetchJson<{
          result: { name: string; metadata?: unknown; expiration?: number }[];
          result_info: { cursor: string };
        }>(`${kv}/keys?prefix=folder%2F&limit=10`);
        expect(keys.result, JSON.stringify(keys)).toHaveLength(10);
        expect(keys.result[0]).toMatchObject({
          name: "folder/a ?é",
          metadata: { kind: "test" },
        });
        expect(keys.result[0].expiration).toBeTypeOf("number");
        expect(keys.result_info.cursor).not.toBe("");
        const next = yield* peer.fetchJson<{ result: { name: string }[] }>(
          `${kv}/keys?prefix=folder%2F&limit=10&cursor=${encodeURIComponent(keys.result_info.cursor)}`,
        );
        expect(next.result.map((key) => key.name)).toEqual(["folder/b9"]);
        expect(
          yield* peer.fetchText(
            `${kv}/values/${encodeURIComponent("folder/a ?é")}`,
          ),
        ).toBe("hello KV");
        expect(
          yield* peer.fetchJson(`${kv}/bulk/get`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ keys: ["folder/a ?é", "missing"] }),
          }),
        ).toMatchObject({
          result: { values: { "folder/a ?é": "hello KV", missing: null } },
        });
        expect((yield* peer.fetch(`${kv}/values/missing`)).status).toBe(404);
        expect(
          (yield* peer.fetch(`${kv}/values/outside`, {
            method: "PUT",
            body: "edited",
          })).status,
        ).toBe(200);
        expect(yield* peer.fetchText(`${kv}/values/outside`)).toBe("edited");
        const objects = yield* peer.fetchJson<{
          result: { id: string; name: string }[];
        }>(`${durable}/objects`);
        expect(objects.result).toContainEqual({
          id: seeded.id,
          name: "named-counter",
          hasStoredData: true,
        });
        const sql = yield* peer.fetchJson(
          `${durable}/query`,
          query("SELECT value FROM counter", seeded.id),
        );
        expect(sql).toMatchObject({
          success: true,
          result: [{ columns: ["value"], rows: [[1]] }],
        });
        expect(
          yield* peer.fetchJson(
            `${API}/workers/durable_objects/namespaces/explorer-bridge/query`,
            query("SELECT value FROM counter", bridge.id),
          ),
        ).toMatchObject({ success: true, result: [{ rows: [[1]] }] });
        const incremented = yield* peer.fetchJson<{ value: number }>("/");
        expect(incremented.value).toBe(2);
        expect(
          (yield* peer.fetch(
            `${API}/workers/durable_objects/namespaces/explorer-legacy/query`,
            query("SELECT 1", seeded.id),
          )).status,
        ).toBe(400);
        expect(
          (yield* peer.fetch(
            `${API}/workers/durable_objects/namespaces/missing/objects`,
          )).status,
        ).toBe(404);
        expect(
          (yield* peer.fetch(`${API}/storage/kv/namespaces/missing/keys`))
            .status,
        ).toBe(404);

        // Queries execute on the real actor, including transactional rollback.
        const failed = yield* peer.fetch(`${durable}/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            durable_object_id: seeded.id,
            queries: [
              { sql: "UPDATE counter SET value = 99" },
              { sql: "SELECT * FROM missing_table" },
            ],
          }),
        });
        expect(failed.status).toBe(400);
        expect(
          yield* peer.fetchJson(
            `${durable}/query`,
            query("SELECT value FROM counter", seeded.id),
          ),
        ).toMatchObject({ result: [{ rows: [[2]] }] });
        yield* Scope.close(ownerScope, Exit.void);
        const restarted = yield* startTestWorker(owner);
        expect(
          yield* restarted.fetchText(
            `${kv}/values/${encodeURIComponent("folder/a ?é")}`,
          ),
        ).toBe("hello KV");
        expect(yield* restarted.fetchJson(`${durable}/objects`)).toMatchObject({
          result: [{ id: seeded.id, name: "named-counter" }],
        });
        expect(
          yield* restarted.fetchJson(
            `${durable}/query`,
            query("SELECT value FROM counter", seeded.id),
          ),
        ).toMatchObject({ result: [{ rows: [[2]] }] });
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "leaves the application route alone when inspection is disabled",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "explorer-disabled",
          compatibilityDate: "2026-08-31",
          compatibilityFlags: [],
          bindings: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content:
                'export default { fetch() { return new Response("application route"); } };',
            },
          ],
        });
        expect(yield* worker.fetchText(`${API}/storage/kv/namespaces`)).toBe(
          "application route",
        );
      }),
  );
});
