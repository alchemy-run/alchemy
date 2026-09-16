/** Configuration for an exact, persistent local Vectorize V2 index. */
export interface VectorizeProps {
  /** Name exposed on the Worker environment. */
  binding: string;
  /** Stable index identity. Bindings sharing an identity share vectors. */
  indexName: string;
  /** Vector width (1–1536). */
  dimensions: number;
  /** Similarity metric. Defaults to cosine. */
  metric?: "cosine" | "euclidean" | "dot-product";
  /** Metadata fields available to filters and returnMetadata: "indexed". */
  /** Generation identities prevent recreated fields from exposing old snapshots. */
  metadataIndexVersions?: Record<string, string>;
  metadataIndexes?: Record<string, "string" | "number" | "boolean">;
}

export interface StoredVector {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
  indexedVersions?: Record<string, string>;
  indexed: Record<string, string | number | boolean>;
}
