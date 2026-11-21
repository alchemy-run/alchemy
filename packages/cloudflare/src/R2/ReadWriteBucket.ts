import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { BindingNameOptions } from "../Workers/WorkerBinding.ts";
import type { Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

/**
 * Combined read/write R2 capability for an Effect-native Worker.
 *
 * Without options the native implementation registers its binding with the
 * resource logical id. With `{ binding: "MEDIA" }`, it **uses** the
 * pre-existing Worker `env.MEDIA` binding instead of registering another.
 * Providing the name does not create a binding; declare it on `env` first.
 *
 * ### Using a named binding
 * **Example:** R2 resource already declared in Worker env
 * ```typescript
 * // The Worker props contain env: { MEDIA: MyBucket }.
 * const media = yield* Cloudflare.R2.ReadWriteBucket(MyBucket, { binding: "MEDIA" });
 * yield* media.put("message.txt", "hello");
 * const object = yield* media.get("message.txt");
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "Cloudflare.R2.ReadWriteBucket",
  (bucket: Bucket, options?: BindingNameOptions) => Effect.Effect<ReadWriteBucketClient>
> {}

export const ReadWriteBucket = Binding.Service<ReadWriteBucket>("Cloudflare.R2.ReadWriteBucket");

export interface ReadWriteBucketClient extends ReadBucketClient, WriteBucketClient {}
