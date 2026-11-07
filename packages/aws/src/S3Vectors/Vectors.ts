import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeReadVectorsClient,
  makeVectorsHttpBinding,
  makeWriteVectorsClient,
  readVectorsActions,
  writeVectorsActions,
} from "./BindingHttp.ts";
import type { Index } from "./VectorIndex.ts";
import type { ReadVectorsClient } from "./VectorsRead.ts";
import type { WriteVectorsClient } from "./VectorsWrite.ts";

/**
 * The read-write runtime data-plane client returned by binding an
 * {@link Index}. All calls target the bound index (its ARN is injected);
 * pass raw distilled request shapes minus the index identifier.
 */
export interface VectorsClient extends ReadVectorsClient, WriteVectorsClient {}

/**
 * Read-write runtime binding for the S3 Vectors data plane — read and write
 * vectors in a bound {@link Index}.
 *
 * Bind an `Index` inside a function runtime to get a {@link VectorsClient}
 * with `put` / `query` / `get` / `list` / `delete`. The binding grants
 * read+write `s3vectors:*Vectors` actions scoped to exactly the bound index's
 * ARN. This is the natural read/write pairing for a vector store — the key
 * enabler for building embedding search and RAG retrieval on top of S3
 * Vectors. For least privilege, prefer {@link VectorsRead} (query/get/list)
 * or {@link VectorsWrite} (put/delete) where one direction suffices.
 *
 * ### Reading and Writing Vectors
 * **Example:** Insert and Query Vectors
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
 *
 * @binding
 */
export interface Vectors extends Binding.Service<
  Vectors,
  "AWS.S3Vectors.Vectors",
  <I extends Index>(index: I) => Effect.Effect<VectorsClient>
> {}
export const Vectors = Binding.Service<Vectors>("AWS.S3Vectors.Vectors");

/**
 * HTTP implementation of {@link Vectors} — calls the S3 Vectors data plane
 * with the host Function's own credentials, granting the full read+write
 * action set on the bound index. Composes the read- and write-level client
 * builders.
 */
export const VectorsHttp = Layer.effect(
  Vectors,
  makeVectorsHttpBinding({
    name: "Vectors",
    actions: [...readVectorsActions, ...writeVectorsActions],
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadVectorsClient;
      const makeWrite = yield* makeWriteVectorsClient;
      return (indexArn: Effect.Effect<string>, label: string): VectorsClient => ({
        ...makeRead(indexArn, label),
        ...makeWrite(indexArn, label),
      });
    }),
  }),
);
