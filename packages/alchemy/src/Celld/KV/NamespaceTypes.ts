import * as Data from "effect/Data";

/** A rejected native KV operation, including unsupported value formats. */
export class NamespaceError extends Data.TaggedError(
  "Celld.KV.NamespaceError",
)<{
  message: string;
  cause: unknown;
}> {}

/** Celld 0.5 decodes stored bytes into these read formats. */
export type NamespaceValueType = "text" | "json" | "arrayBuffer" | "stream";

export interface NamespaceGetOptions<
  Type extends NamespaceValueType | undefined,
> {
  /** Defaults to text. */
  type: Type;
  /** Accepted for compatibility; Celld has no read cache. */
  cacheTtl?: number;
}

export interface NamespacePutOptions {
  /** Absolute expiration in Unix seconds. */
  expiration?: number;
  /** Relative expiration in seconds; takes precedence over expiration. */
  expirationTtl?: number;
  /** JSON-serializable metadata, limited to 1024 encoded bytes. */
  metadata?: unknown;
}

export interface NamespaceListOptions {
  /** Maximum number of keys, from 1 to 1000. */
  limit?: number;
  /** Return keys beginning with this prefix. */
  prefix?: string;
  /** Opaque cursor returned by an incomplete page. */
  cursor?: string;
}

export interface NamespaceGetWithMetadataResult<Value, Metadata> {
  /** Null when the key is absent or expired. */
  value: Value | null;
  /** Null when absent or no metadata was written. */
  metadata: Metadata | null;
  /** Celld has no read cache. */
  cacheStatus: null;
}

/** Celld 0.5 omits cacheStatus from bulk metadata entries. */
export type NamespaceBulkGetWithMetadataResult<Value, Metadata> = Omit<
  NamespaceGetWithMetadataResult<Value, Metadata>,
  "cacheStatus"
>;

export type NamespaceListResult<Metadata, Key extends string = string> = {
  /** Listed keys include metadata and expiration only when present. */
  keys: { name: Key; expiration?: number; metadata?: Metadata }[];
  /** Celld does not cache reads. */
  cacheStatus: null;
} & ({ list_complete: true } | { list_complete: false; cursor: string });

type DecodedValue<Type, Json> = Type extends "json"
  ? Json
  : Type extends "arrayBuffer"
    ? ArrayBuffer
    : Type extends "stream"
      ? ReadableStream<Uint8Array>
      : string;
type ReadResult<Key, Value> = Key extends string[] ? Map<string, Value> : Value;

/** Native Celld surface, not Cloudflare's broader namespace interface. */
export interface NativeNamespace {
  get<Json = unknown>(
    key: string,
    options: "json" | NamespaceGetOptions<"json">,
  ): Promise<Json | null>;
  get<Json = unknown>(
    key: string[],
    options: "json" | NamespaceGetOptions<"json">,
  ): Promise<Map<string, Json | null>>;
  get<Key extends string | string[], Type extends NamespaceValueType = "text">(
    key: Key,
    options?: Type | Partial<NamespaceGetOptions<Type>>,
  ): Promise<ReadResult<Key, DecodedValue<Type, unknown> | null>>;
  getWithMetadata<Json = unknown, Metadata = unknown>(
    key: string,
    options: "json" | NamespaceGetOptions<"json">,
  ): Promise<NamespaceGetWithMetadataResult<Json, Metadata>>;
  getWithMetadata<Json = unknown, Metadata = unknown>(
    key: string[],
    options: "json" | NamespaceGetOptions<"json">,
  ): Promise<Map<string, NamespaceBulkGetWithMetadataResult<Json, Metadata>>>;
  getWithMetadata<Metadata = unknown>(
    key: string,
    options?: "text" | Partial<NamespaceGetOptions<"text">>,
  ): Promise<NamespaceGetWithMetadataResult<string, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: string[],
    options?: "text" | Partial<NamespaceGetOptions<"text">>,
  ): Promise<Map<string, NamespaceBulkGetWithMetadataResult<string, Metadata>>>;
  getWithMetadata<
    Key extends string | string[],
    Type extends NamespaceValueType = "text",
  >(
    key: Key,
    options?: Type | Partial<NamespaceGetOptions<Type>>,
  ): Promise<
    Key extends string[]
      ? Map<
          string,
          NamespaceBulkGetWithMetadataResult<
            DecodedValue<Type, unknown>,
            unknown
          >
        >
      : NamespaceGetWithMetadataResult<DecodedValue<Type, unknown>, unknown>
  >;
  list<Metadata = unknown, Key extends string = string>(
    options?: NamespaceListOptions,
  ): Promise<NamespaceListResult<Metadata, Key>>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: NamespacePutOptions,
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Read-only typing does not turn a native namespace into a security boundary. */
export type NativeReadNamespace = Pick<
  NativeNamespace,
  "get" | "getWithMetadata" | "list"
>;
