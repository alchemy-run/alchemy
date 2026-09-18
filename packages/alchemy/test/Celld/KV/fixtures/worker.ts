import type { Namespace } from "@/Celld/KV/Namespace";
import { ReadWriteNamespace } from "@/Celld/KV/ReadWriteNamespace";
import { ReadWriteNamespaceBinding } from "@/Celld/KV/ReadWriteNamespaceBinding";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Worker implementation for the parent's real Celld 0.5 fleet and namespace. */
export const kvBindingConformance = (namespace: Namespace) =>
  Effect.gen(function* () {
    const kv = yield* ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const prefix = "alchemy-kv-binding/";
        const textKey = `${prefix}a`;
        const bytesKey = `${prefix}b`;
        const invalidKey = `${prefix}c`;
        yield* kv.delete(textKey);
        yield* kv.delete(bytesKey);
        yield* kv.delete(invalidKey);
        const missing = yield* kv.get(textKey);
        yield* kv.put(textKey, '{"hello":"celld"}', {
          metadata: { version: 1 },
          expirationTtl: 120,
        });
        const json = yield* kv.get<{ hello: string }>(textKey, {
          type: "json",
          cacheTtl: 60,
        });
        const metadata = yield* kv.getWithMetadata<
          { hello: string },
          { version: number }
        >(textKey, "json");
        const bulk = yield* kv.getWithMetadata<{ version: number }>(
          [textKey, `${prefix}missing`],
          "text",
        );
        yield* kv.put(bytesKey, new Uint8Array([0, 255, 1]));
        const binary = yield* kv.get(bytesKey, "arrayBuffer");
        const streamed = yield* kv.get(bytesKey, "stream");
        const streamBytes = yield* Effect.tryPromise(() =>
          new Response(streamed).arrayBuffer(),
        );
        const first = yield* kv.list<{ version: number }>({ prefix, limit: 1 });
        const second = first.list_complete
          ? undefined
          : yield* kv.list({ prefix, limit: 1, cursor: first.cursor });
        yield* kv.put(invalidKey, "not-json");
        const invalid = yield* Effect.result(kv.get(invalidKey, "json"));
        const blob = yield* Effect.sync(() => new Blob(["unsupported"]));
        const unsupported = yield* Effect.result(
          kv.put(invalidKey, blob as unknown as ArrayBuffer),
        );
        yield* kv.put(textKey, "updated");
        const updated = yield* kv.getWithMetadata(textKey);
        yield* kv.delete(textKey);
        yield* kv.delete(bytesKey);
        yield* kv.delete(invalidKey);
        yield* kv.delete(invalidKey);
        const deleted = yield* kv.get(textKey);
        const empty = yield* kv.list({ prefix });
        return yield* HttpServerResponse.json({
          missing,
          json,
          metadata,
          bulk: [...bulk.entries()],
          binary: Array.from(new Uint8Array(binary!)),
          streamed: Array.from(new Uint8Array(streamBytes)),
          first,
          second,
          updated,
          deleted,
          empty,
          invalid: Result.isFailure(invalid) ? invalid.failure._tag : null,
          unsupported: Result.isFailure(unsupported)
            ? unsupported.failure._tag
            : null,
        });
      }),
    };
  }).pipe(Effect.provide(ReadWriteNamespaceBinding));
