import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  Conditional,
  R2Error,
  GetOptions,
  ListOptions,
  NativeReadBucket,
  R2Object,
  ObjectBody,
  Objects,
} from "./BucketTypes.ts";

export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Celld.R2.ReadBucket",
  (bucket: Bucket) => Effect.Effect<ReadBucketClient>
> {}

/**
 * Read objects from a keyspace in the Celld fleet's backing bucket.
 * Native access levels are TypeScript views, not separate authorization grants.
 * Celld 0.5 does not support customer-key encryption or secondsGranularity.
 *
 * ### Read an object
 * **Example:** Serve stored text from a Worker handler
 * ```typescript
 * const files = yield* Celld.R2.ReadBucket(bucket);
 * const fetch = Effect.gen(function* () {
 *   const object = yield* files.get("hello.txt");
 *   return HttpServerResponse.text(object ? yield* object.text() : "missing");
 * });
 * ```
 * Provide `Celld.R2.ReadBucketBinding` on the Worker's initialization effect.
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export const ReadBucket = Binding.Service<ReadBucket>("Celld.R2.ReadBucket");

export interface ReadBucketClient {
  /** Native read view; not a security boundary. Use only within the current request. */
  raw: Effect.Effect<NativeReadBucket, R2Error, RuntimeContext>;
  head(key: string): Effect.Effect<R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options: GetOptions & { onlyIf: Conditional | Headers },
  ): Effect.Effect<ObjectBody | R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options?: Omit<GetOptions, "onlyIf"> & { onlyIf?: undefined },
  ): Effect.Effect<ObjectBody | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options: GetOptions,
  ): Effect.Effect<ObjectBody | R2Object | null, R2Error, RuntimeContext>;
  list(options?: ListOptions): Effect.Effect<Objects, R2Error, RuntimeContext>;
}
