import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";

const url = process.env.CELLD_KV_BINDING_TEST_URL;

// The parent deploys fixtures/worker.ts against its shared real 0.5 node.
describe.skipIf(!url)("Celld 0.5 KV binding conformance", () => {
  test.effect(
    "native CRUD, metadata, bytes, listing and unsupported inputs",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(url!);
        expect(response.status).toBe(200);
        const value = (yield* response.json) as {
          missing: null;
          json: { hello: string };
          metadata: unknown;
          bulk: unknown;
          binary: number[];
          streamed: number[];
          first: {
            list_complete: boolean;
            keys: { name: string }[];
            cacheStatus: null;
          };
          second: { list_complete: boolean; keys: { name: string }[] };
          updated: unknown;
          deleted: null;
          empty: { keys: unknown[] };
          invalid: string;
          unsupported: string;
        };
        expect(value.missing).toBeNull();
        expect(value.json).toEqual({ hello: "celld" });
        expect(value.metadata).toEqual({
          value: { hello: "celld" },
          metadata: { version: 1 },
          cacheStatus: null,
        });
        expect(value.bulk).toEqual([
          [
            "alchemy-kv-binding/a",
            { value: '{"hello":"celld"}', metadata: { version: 1 } },
          ],
          ["alchemy-kv-binding/missing", { value: null, metadata: null }],
        ]);
        expect(value.binary).toEqual([0, 255, 1]);
        expect(value.streamed).toEqual([0, 255, 1]);
        expect(value.first.list_complete).toBe(false);
        expect(value.first.cacheStatus).toBeNull();
        expect(value.second.list_complete).toBe(true);
        expect(value.second.keys.map((key) => key.name)).toEqual([
          "alchemy-kv-binding/b",
        ]);
        expect(value.updated).toEqual({
          value: "updated",
          metadata: null,
          cacheStatus: null,
        });
        expect(value.invalid).toBe("Celld.KV.NamespaceError");
        expect(value.unsupported).toBe("Celld.KV.NamespaceError");
        expect(value.deleted).toBeNull();
        expect(value.empty.keys).toEqual([]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    { timeout: 90000 },
  );
});
