import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { KVNamespace } from "./Namespace.ts";
import type { KVNamespaceError } from "./NamespaceTypes.ts";

/**
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export class KVNamespaceRead extends Binding.Service<
  KVNamespaceRead,
  (namespace: KVNamespace) => Effect.Effect<ReadKVNamespaceClient>
>()("Cloudflare.KVNamespace.Read") {}

export const ReadNamespace = KVNamespaceRead.bind;

export interface ReadKVNamespaceClient<Key extends string = string> {
  raw: Effect.Effect<runtime.KVNamespace, never, RuntimeContext>;
  get(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<string | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "text",
  ): Effect.Effect<string | null, KVNamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<ExpectedValue | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<ArrayBuffer | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    type: "stream",
  ): Effect.Effect<ReadableStream | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<string | null, KVNamespaceError, RuntimeContext>;
  get<ExpectedValue = unknown>(
    key: Key,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<ExpectedValue | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<ArrayBuffer | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<ReadableStream | null, KVNamespaceError, RuntimeContext>;
  get(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<
    Map<string, string | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    Map<string, string | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    Map<string, string | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, ExpectedValue | null>,
    KVNamespaceError,
    RuntimeContext
  >;
  list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Effect.Effect<
    KVNamespaceListResult<Metadata, Key>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "text",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    type: "json",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "arrayBuffer",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "stream",
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<string, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"arrayBuffer">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"stream">,
  ): Effect.Effect<
    KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    type: "text",
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    type: "json",
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Effect.Effect<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>,
    KVNamespaceError,
    RuntimeContext
  >;
}
