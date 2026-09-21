import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type {
  NamespaceError,
  NativeReadNamespace,
  NamespaceGetOptions as KVNamespaceGetOptions,
  NamespaceGetWithMetadataResult as KVNamespaceGetWithMetadataResult,
  NamespaceBulkGetWithMetadataResult as KVNamespaceBulkGetWithMetadataResult,
  NamespaceListOptions as KVNamespaceListOptions,
  NamespaceListResult as KVNamespaceListResult,
} from "./NamespaceTypes.ts";

export interface ReadNamespace extends Binding.Service<
  ReadNamespace,
  "Celld.KV.ReadNamespace",
  (namespace: Namespace) => Effect.Effect<ReadNamespaceClient>
> {}

/**
 * Read a Celld KV namespace through its single writer. `cacheTtl` is accepted
 * but has no effect; single metadata reads and listings report null cacheStatus,
 * while bulk metadata entries omit cacheStatus. Read types include text, JSON,
 * arrayBuffer and stream. The read view is not an authorization boundary.
 *
 * ### Read JSON
 * **Example:** Read a stored document in a Worker handler
 * ```typescript
 * const kv = yield* Celld.KV.ReadNamespace(namespace);
 * const fetch = Effect.gen(function* () {
 *   const value = yield* kv.get<{ name: string }>("profile", "json");
 *   return HttpServerResponse.json(value);
 * });
 * ```
 * Provide `Celld.KV.ReadNamespaceBinding` on the Worker's initialization effect.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export const ReadNamespace = Binding.Service<ReadNamespace>(
  "Celld.KV.ReadNamespace",
);

export interface ReadNamespaceClient<Key extends string = string> {
  /** Native read view. Celld grants the Worker full namespace authority; this is not an ACL. */
  raw: Effect.Effect<NativeReadNamespace, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<string | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "text",
  ): Effect.Effect<string | null, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<ExpectedValue | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<ArrayBuffer | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "stream",
  ): Effect.Effect<ReadableStream | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<string | null, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<ExpectedValue | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<ArrayBuffer | null, NamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<ReadableStream | null, NamespaceError, RuntimeContext>;
  get(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<Map<string, string | null>, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    NamespaceError,
    RuntimeContext
  >;
  get(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<Map<string, string | null>, NamespaceError, RuntimeContext>;
  get(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<Map<string, string | null>, NamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    NamespaceError,
    RuntimeContext
  >;
  list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Effect.Effect<
    KVNamespaceListResult<Metadata, Key>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "text",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "stream",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<
    Map<string, KVNamespaceBulkGetWithMetadataResult<string, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, KVNamespaceBulkGetWithMetadataResult<ExpectedValue, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    Map<string, KVNamespaceBulkGetWithMetadataResult<string, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    Map<string, KVNamespaceBulkGetWithMetadataResult<string, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, KVNamespaceBulkGetWithMetadataResult<ExpectedValue, Metadata>>,
    NamespaceError,
    RuntimeContext
  >;
}
