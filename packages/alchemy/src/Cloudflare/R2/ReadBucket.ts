import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { R2Bucket } from "./Bucket.ts";
import type {
  R2Error,
  R2GetOptions,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
} from "./BucketTypes.ts";

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Cloudflare.R2.ReadBucket",
  (bucket: R2Bucket) => Effect.Effect<ReadBucketClient>
> {}

export const ReadBucket = Binding.Service<ReadBucket>(
  "Cloudflare.R2.ReadBucket",
);

export interface ReadBucketClient {
  raw: Effect.Effect<runtime.R2Bucket, never, RuntimeContext>;
  head(key: string): Effect.Effect<R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options: R2GetOptions & {
      onlyIf: runtime.R2Conditional | Headers;
    },
  ): Effect.Effect<R2ObjectBody | R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options?: R2GetOptions,
  ): Effect.Effect<R2ObjectBody | null, R2Error, RuntimeContext>;
  list(
    options?: R2ListOptions,
  ): Effect.Effect<R2Objects, R2Error, RuntimeContext>;
}
