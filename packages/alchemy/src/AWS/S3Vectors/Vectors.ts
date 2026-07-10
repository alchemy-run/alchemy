import type * as s3vectors from "@distilled.cloud/aws/s3vectors";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./VectorIndex.ts";

/** Fields the binding injects from the bound {@link Index}. */
type IndexRef = "vectorBucketName" | "indexName" | "indexArn";

export interface PutVectorsRequest extends Omit<
  s3vectors.PutVectorsInput,
  IndexRef
> {}
export interface QueryVectorsRequest extends Omit<
  s3vectors.QueryVectorsInput,
  IndexRef
> {}
export interface GetVectorsRequest extends Omit<
  s3vectors.GetVectorsInput,
  IndexRef
> {}
export interface ListVectorsRequest extends Omit<
  s3vectors.ListVectorsInput,
  IndexRef
> {}
export interface DeleteVectorsRequest extends Omit<
  s3vectors.DeleteVectorsInput,
  IndexRef
> {}

/**
 * The runtime data-plane client returned by binding an {@link Index}. All
 * calls target the bound index (its ARN is injected); pass raw distilled
 * request shapes minus the index identifier.
 */
export interface VectorsClient {
  /** Insert or overwrite vectors (keyed by `key`). */
  readonly put: (
    request: PutVectorsRequest,
  ) => Effect.Effect<s3vectors.PutVectorsOutput, s3vectors.PutVectorsError>;
  /** Nearest-neighbor similarity query. */
  readonly query: (
    request: QueryVectorsRequest,
  ) => Effect.Effect<s3vectors.QueryVectorsOutput, s3vectors.QueryVectorsError>;
  /** Fetch vectors by key. */
  readonly get: (
    request: GetVectorsRequest,
  ) => Effect.Effect<s3vectors.GetVectorsOutput, s3vectors.GetVectorsError>;
  /** List vectors (paginated / segmented scan). */
  readonly list: (
    request: ListVectorsRequest,
  ) => Effect.Effect<s3vectors.ListVectorsOutput, s3vectors.ListVectorsError>;
  /** Delete vectors by key. */
  readonly delete: (
    request: DeleteVectorsRequest,
  ) => Effect.Effect<
    s3vectors.DeleteVectorsOutput,
    s3vectors.DeleteVectorsError
  >;
}

/**
 * Runtime binding for the S3 Vectors data plane — read and write vectors in a
 * bound {@link Index}.
 *
 * Bind an `Index` inside a function runtime to get a {@link VectorsClient}
 * with `put` / `query` / `get` / `list` / `delete`. The binding grants
 * read+write `s3vectors:*Vectors` actions scoped to exactly the bound index's
 * ARN. This is the natural read/write pairing for a vector store — the key
 * enabler for building embedding search and RAG retrieval on top of S3
 * Vectors.
 *
 * @binding
 * @section Reading and Writing Vectors
 * @example Insert and Query Vectors
 * ```typescript
 * // init
 * const vectors = yield* AWS.S3Vectors.Vectors(index);
 *
 * // runtime — insert
 * yield* vectors.put({
 *   vectors: [
 *     { key: "doc-1", data: { float32: [0.1, 0.2, 0.3] } },
 *   ],
 * });
 *
 * // runtime — query nearest neighbors
 * const result = yield* vectors.query({
 *   topK: 5,
 *   queryVector: { float32: [0.1, 0.2, 0.3] },
 *   returnDistance: true,
 * });
 * ```
 */
export interface Vectors extends Binding.Service<
  Vectors,
  "AWS.S3Vectors.Vectors",
  <I extends Index>(index: I) => Effect.Effect<VectorsClient>
> {}
export const Vectors = Binding.Service<Vectors>("AWS.S3Vectors.Vectors");
