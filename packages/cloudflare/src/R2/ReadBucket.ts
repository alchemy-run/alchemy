import type * as runtime from "@cloudflare/workers-types";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { BindingNameOptions } from "../Workers/WorkerBinding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  R2Error,
  GetOptions,
  ListOptions,
  R2Object,
  ObjectBody,
  Objects,
} from "./BucketTypes.ts";

/**
 * Read R2 objects from an Effect-native Worker.
 *
 * Without options, {@link ReadBucketBinding} registers a Worker binding
 * named after the bucket's logical id. With `{ binding: "MEDIA" }`, it uses
 * the existing `env: { MEDIA: bucket }` binding instead, without adding a
 * duplicate logical-id binding. HTTP/local implementations do not use
 * Worker env names.
 *
 * ### Using a declared Worker binding
 * **Example:** Read from a named R2 binding
 * ```typescript
 * // The host Worker declares env: { MEDIA: MyBucket }.
 * const media = yield* Cloudflare.R2.ReadBucket(MyBucket, { binding: "MEDIA" });
 * const object = yield* media.get("image.png");
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Cloudflare.R2.ReadBucket",
  (bucket: Bucket, options?: BindingNameOptions) => Effect.Effect<ReadBucketClient>
> {}

export const ReadBucket = Binding.Service<ReadBucket>("Cloudflare.R2.ReadBucket");

export interface ReadBucketClient {
  raw: Effect.Effect<runtime.R2Bucket, never, RuntimeContext>;
  head(key: string): Effect.Effect<R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options: GetOptions & {
      onlyIf: runtime.R2Conditional | Headers;
    },
  ): Effect.Effect<ObjectBody | R2Object | null, R2Error, RuntimeContext>;
  get(key: string, options?: GetOptions): Effect.Effect<ObjectBody | null, R2Error, RuntimeContext>;
  list(options?: ListOptions): Effect.Effect<Objects, R2Error, RuntimeContext>;
}
