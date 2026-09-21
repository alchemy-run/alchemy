import { makeKVNamespaceHelpers } from "@/Celld/KV/NamespaceBinding";
import type {
  NativeNamespace,
  NamespaceGetOptions,
  NamespacePutOptions,
  NamespaceListOptions,
  NamespaceValueType,
} from "@/Celld/KV/NamespaceTypes";
import {
  ReadNamespace,
  type ReadNamespaceClient,
} from "@/Celld/KV/ReadNamespace";
import { makeReadWriteKVClient } from "@/Celld/KV/ReadWriteNamespaceBinding";
import { ReadWriteNamespace } from "@/Celld/KV/ReadWriteNamespace";
import {
  WriteNamespace,
  type WriteNamespaceClient,
} from "@/Celld/KV/WriteNamespace";
import { RuntimeContext } from "@/RuntimeContext";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type KVRequestContracts = [
  Assert<
    Equal<
      Effect.Services<ReturnType<ReadNamespaceClient["get"]>>,
      RuntimeContext
    >
  >,
  Assert<
    Equal<
      Effect.Services<ReturnType<ReadNamespaceClient["getWithMetadata"]>>,
      RuntimeContext
    >
  >,
  Assert<
    Equal<
      Effect.Services<ReturnType<ReadNamespaceClient["list"]>>,
      RuntimeContext
    >
  >,
  Assert<
    Equal<
      Effect.Services<ReturnType<WriteNamespaceClient["put"]>>,
      RuntimeContext
    >
  >,
  Assert<Equal<Effect.Services<ReadNamespaceClient["raw"]>, RuntimeContext>>,
  Assert<
    Equal<
      keyof Effect.Success<ReadNamespaceClient["raw"]>,
      "get" | "getWithMetadata" | "list"
    >
  >,
];

const request = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  effect.pipe(Effect.provide(RuntimeContext.phantom));

const fixture = () => {
  const entries = new Map<
    string,
    { bytes: Uint8Array; metadata: unknown; expiration?: number }
  >();
  const calls: { operation: string; options: unknown }[] = [];
  const read = (
    key: string,
    options?:
      | NamespaceValueType
      | Partial<NamespaceGetOptions<NamespaceValueType>>,
  ) => {
    const entry = entries.get(key);
    if (!entry) return { value: null, metadata: null };
    const type = typeof options === "string" ? options : options?.type;
    const value =
      type === "arrayBuffer"
        ? entry.bytes.slice().buffer
        : type === "stream"
          ? new Response(entry.bytes.slice().buffer).body
          : type === "json"
            ? JSON.parse(new TextDecoder().decode(entry.bytes))
            : new TextDecoder().decode(entry.bytes);
    return { value, metadata: entry.metadata };
  };
  const native: NativeNamespace = {
    get: ((
      key: string | string[],
      options?:
        | NamespaceValueType
        | Partial<NamespaceGetOptions<NamespaceValueType>>,
    ) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ operation: "get", options });
          return Array.isArray(key)
            ? new Map(key.map((key) => [key, read(key, options).value]))
            : read(key, options).value;
        }),
      )) as NativeNamespace["get"],
    getWithMetadata: ((
      key: string | string[],
      options?:
        | NamespaceValueType
        | Partial<NamespaceGetOptions<NamespaceValueType>>,
    ) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ operation: "getWithMetadata", options });
          return Array.isArray(key)
            ? new Map(key.map((key) => [key, read(key, options)]))
            : { ...read(key, options), cacheStatus: null };
        }),
      )) as NativeNamespace["getWithMetadata"],
    put: (key, value, options) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ operation: "put", options });
          const bytes =
            typeof value === "string"
              ? new TextEncoder().encode(value)
              : value instanceof ArrayBuffer
                ? new Uint8Array(value.slice(0))
                : new Uint8Array(
                    value.buffer,
                    value.byteOffset,
                    value.byteLength,
                  ).slice();
          entries.set(key, {
            bytes,
            metadata:
              options?.metadata === undefined
                ? null
                : JSON.parse(JSON.stringify(options.metadata)),
            expiration: options?.expiration,
          });
        }),
      ),
    delete: (key) =>
      Effect.runPromise(
        Effect.sync(() => {
          entries.delete(key);
        }),
      ),
    list: ((options?: NamespaceListOptions) =>
      Effect.runPromise(
        Effect.sync(() => {
          calls.push({ operation: "list", options });
          const names = [...entries.keys()]
            .sort()
            .filter(
              (key) =>
                key.startsWith(options?.prefix ?? "") &&
                key > (options?.cursor ?? ""),
            );
          const page = names.slice(0, options?.limit ?? 1000);
          const keys = page.map((name) => {
            const entry = entries.get(name)!;
            return {
              name,
              ...(entry.metadata === null ? {} : { metadata: entry.metadata }),
              ...(entry.expiration === undefined
                ? {}
                : { expiration: entry.expiration }),
            };
          });
          return page.length < names.length
            ? {
                keys,
                list_complete: false,
                cursor: page[page.length - 1],
                cacheStatus: null,
              }
            : { keys, list_complete: true, cacheStatus: null };
        }),
      )) as NativeNamespace["list"],
  };
  const client = makeReadWriteKVClient(
    makeKVNamespaceHelpers({ KV: native }, { LogicalId: "KV" }),
  );
  return { client, native, calls };
};

describe("Celld KV native client adapters", () => {
  test.effect(
    "CRUD preserves metadata, JSON generics, nulls and bulk Maps",
    () =>
      request(
        Effect.gen(function* () {
          const { client } = fixture();
          yield* client.put("profile", '{"name":"sam"}', {
            metadata: { revision: 1 },
          });
          expect(
            yield* client.get<{ name: string }>("profile", "json"),
          ).toEqual({ name: "sam" });
          const row = yield* client.getWithMetadata<
            { name: string },
            { revision: number }
          >("profile", "json");
          expect(row).toEqual({
            value: { name: "sam" },
            metadata: { revision: 1 },
            cacheStatus: null,
          });
          const bulk = yield* client.get(["profile", "absent"], "text");
          expect(bulk).toBeInstanceOf(Map);
          expect(bulk.get("absent")).toBeNull();
          const metadata = yield* client.getWithMetadata<{ revision: number }>(
            ["profile", "absent"],
            "text",
          );
          expect(metadata.get("profile")).toEqual({
            value: '{"name":"sam"}',
            metadata: { revision: 1 },
          });
          expect(metadata.get("absent")).toEqual({
            value: null,
            metadata: null,
          });
          yield* client.put("profile", "updated");
          expect(yield* client.getWithMetadata("profile")).toEqual({
            value: "updated",
            metadata: null,
            cacheStatus: null,
          });
          yield* client.delete("profile");
          yield* client.delete("profile");
          expect(yield* client.get("profile")).toBeNull();
        }),
      ),
  );

  test.effect("binary slices and streaming reads preserve bytes", () =>
    request(
      Effect.gen(function* () {
        const { client } = fixture();
        yield* client.put(
          "bytes",
          new Uint8Array([99, 0, 255, 98]).subarray(1, 3),
        );
        const buffer = yield* client.get("bytes", { type: "arrayBuffer" });
        expect(Array.from(new Uint8Array(buffer!))).toEqual([0, 255]);
        const body = yield* client.get("bytes", "stream");
        const streamed = yield* Effect.tryPromise(() =>
          new Response(body).arrayBuffer(),
        );
        expect(Array.from(new Uint8Array(streamed))).toEqual([0, 255]);
      }),
    ),
  );

  test.effect(
    "forwards read, write and list options without adding cache claims",
    () =>
      request(
        Effect.gen(function* () {
          const { client, calls } = fixture();
          const options: NamespacePutOptions = {
            metadata: { n: 1 },
            expiration: 2_000_000_000,
            expirationTtl: 120,
          };
          yield* client.put("p/a", "a", options);
          yield* client.put("p/b", "b");
          yield* client.put("other", "c");
          yield* client.get("p/a", { type: "text", cacheTtl: 60 });
          const first = yield* client.list<{ n: number }>({
            prefix: "p/",
            limit: 1,
          });
          expect(first.list_complete).toBe(false);
          expect(first.keys[0].metadata).toEqual({ n: 1 });
          expect(first.cacheStatus).toBeNull();
          if (!first.list_complete) {
            const second = yield* client.list({
              prefix: "p/",
              limit: 1,
              cursor: first.cursor,
            });
            expect(second.list_complete).toBe(true);
            expect(second.keys.map((key) => key.name)).toEqual(["p/b"]);
          }
          expect(calls[0].options).toBe(options);
          expect(
            calls.find((call) => call.operation === "get")?.options,
          ).toEqual({ type: "text", cacheTtl: 60 });
        }),
      ),
  );

  test.effect("wraps parse errors, native failures and missing bindings", () =>
    request(
      Effect.gen(function* () {
        const { client, native } = fixture();
        yield* client.put("bad", "not json");
        const badJson = yield* Effect.result(client.get("bad", "json"));
        expect(Result.isFailure(badJson) && badJson.failure._tag).toBe(
          "Celld.KV.NamespaceError",
        );
        native.delete = () => {
          throw null;
        };
        const failed = yield* Effect.result(client.delete("bad"));
        expect(Result.isFailure(failed) && failed.failure.cause).toBeNull();
        const missing = makeReadWriteKVClient(
          makeKVNamespaceHelpers({}, { LogicalId: "missing" }),
        );
        const absent = yield* Effect.result(missing.raw);
        expect(Result.isFailure(absent) && absent.failure.message).toContain(
          "Missing Celld KV binding",
        );
      }),
    ),
  );

  test.effect(
    "rejects stream and blob writes rather than fabricating support",
    () =>
      request(
        Effect.gen(function* () {
          const { client, calls } = fixture();
          const values = yield* Effect.sync(() => [
            new Blob(["x"]),
            new Response("x").body,
          ]);
          for (const value of values) {
            const result = yield* Effect.result(
              client.put("unsupported", value as unknown as ArrayBuffer),
            );
            expect(Result.isFailure(result) && result.failure._tag).toBe(
              "Celld.KV.NamespaceError",
            );
            expect(
              Result.isFailure(result) && result.failure.message,
            ).toContain("streams and blobs are unsupported");
          }
          expect(calls).toEqual([]);
        }),
      ),
  );

  test("owns callable service identities", () => {
    expect(typeof ReadNamespace).toBe("function");
    expect(ReadNamespace.key).toBe("Celld.KV.ReadNamespace");
    expect(WriteNamespace.key).toBe("Celld.KV.WriteNamespace");
    expect(ReadWriteNamespace.key).toBe("Celld.KV.ReadWriteNamespace");
  });
});
