import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";

/** A native R2 failure, including unsupported Celld operations. */
export class R2Error extends Data.TaggedError("Celld.R2.R2Error")<{
  message: string;
  cause: unknown;
}> {}

/** Metadata Celld 0.5 persists with an object. */
export interface HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
  /** Unsupported by Celld 0.5; supplying this option fails with R2Error. */
  secondsGranularity?: boolean;
}

export type Range =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

export interface GetOptions {
  onlyIf?: Conditional | Headers;
  range?: Range | Headers;
  /** Unsupported by Celld 0.5; supplying a customer key fails with R2Error. */
  ssecKey?: ArrayBuffer | string;
}

export interface MultipartOptions {
  httpMetadata?: HttpMetadata | Headers;
  customMetadata?: Record<string, string>;
  storageClass?: "Standard" | "InfrequentAccess";
  /** Unsupported by Celld 0.5. */
  ssecKey?: ArrayBuffer | string;
}

export interface PutOptions extends MultipartOptions {
  /** Conditional writes larger than a single native request fail rather than lose the condition. */
  onlyIf?: Conditional | Headers;
  md5?: ArrayBuffer | ArrayBufferView | string;
  sha1?: ArrayBuffer | ArrayBufferView | string;
  sha256?: ArrayBuffer | ArrayBufferView | string;
  sha384?: ArrayBuffer | ArrayBufferView | string;
  sha512?: ArrayBuffer | ArrayBufferView | string;
  /** Compatibility hint; Celld streams do not require a known length. Not sent to the native binding. */
  contentLength?: number;
}

export interface ListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

export interface Checksums {
  readonly md5?: ArrayBuffer;
  readonly sha1?: ArrayBuffer;
  readonly sha256?: ArrayBuffer;
  readonly sha384?: ArrayBuffer;
  readonly sha512?: ArrayBuffer;
  toJSON(): Partial<
    Record<"md5" | "sha1" | "sha256" | "sha384" | "sha512", string>
  >;
}

/** Native metadata returned by the fleet bucket's keyspace. */
export interface NativeObject {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: HttpMetadata;
  readonly customMetadata: Record<string, string>;
  readonly checksums: Checksums;
  readonly storageClass: string;
  readonly range?: Range;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2Object extends Omit<NativeObject, "writeHttpMetadata"> {
  writeHttpMetadata(
    headers: Headers,
  ): Effect.Effect<void, R2Error, RuntimeContext>;
}

export interface NativeObjectBody extends NativeObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface ObjectBody extends R2Object {
  /** Consume either this Effect stream or readable, never both. */
  readonly body: Stream.Stream<Uint8Array, R2Error, RuntimeContext>;
  /** The native body, for direct Response forwarding within the current request. */
  readonly readable: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  arrayBuffer(): Effect.Effect<ArrayBuffer, R2Error, RuntimeContext>;
  bytes(): Effect.Effect<Uint8Array, R2Error, RuntimeContext>;
  text(): Effect.Effect<string, R2Error, RuntimeContext>;
  json<T>(): Effect.Effect<T, R2Error, RuntimeContext>;
  blob(): Effect.Effect<Blob, R2Error, RuntimeContext>;
}

type Page<Object> = { objects: Object[]; delimitedPrefixes: string[] } & (
  | { truncated: true; cursor: string }
  | { truncated: false }
);
export type Objects = Page<R2Object>;
export type NativeObjects = Page<NativeObject>;
export type BucketValue =
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob;

export interface UploadedPart {
  partNumber: number;
  /** Celld 0.5 returns an empty etag; completion identifies parts by number. */
  etag: string;
}
export interface UploadPartOptions {
  /** Unsupported by Celld 0.5. */
  ssecKey?: ArrayBuffer | string;
}

export interface NativeMultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: Exclude<BucketValue, null>,
    options?: UploadPartOptions,
  ): Promise<UploadedPart>;
  abort(): Promise<void>;
  complete(parts: UploadedPart[]): Promise<NativeObject>;
}

/** Multipart handles are node-local; resume can fail after restart or on another node. */
export interface MultipartUpload {
  /** Native escape hatch, usable only during the request that obtained this handle. */
  readonly raw: NativeMultipartUpload;
  readonly key: string;
  readonly uploadId: string;
  uploadPart<Err = never>(
    partNumber: number,
    value: Exclude<BucketValue, null> | Stream.Stream<Uint8Array, Err>,
    options?: UploadPartOptions,
  ): Effect.Effect<UploadedPart, R2Error | Err, RuntimeContext>;
  abort(): Effect.Effect<void, R2Error, RuntimeContext>;
  complete(
    parts: UploadedPart[],
  ): Effect.Effect<R2Object, R2Error, RuntimeContext>;
}

/** Celld's native methods, not the Cloudflare R2Bucket interface. */
export interface NativeBucket {
  head(key: string): Promise<NativeObject | null>;
  get(
    key: string,
    options?: GetOptions,
  ): Promise<NativeObject | NativeObjectBody | null>;
  put(
    key: string,
    value: BucketValue,
    options?: PutOptions,
  ): Promise<NativeObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: ListOptions): Promise<NativeObjects>;
  createMultipartUpload(
    key: string,
    options?: MultipartOptions,
  ): Promise<NativeMultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): NativeMultipartUpload;
}

/** Read view only; the Worker still has full native bucket authority. */
export type NativeReadBucket = Pick<NativeBucket, "head" | "get" | "list">;
