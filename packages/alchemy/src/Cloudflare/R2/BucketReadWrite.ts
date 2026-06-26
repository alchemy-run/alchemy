import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { R2Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./BucketRead.ts";
import type { WriteBucketClient } from "./BucketWrite.ts";

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export class BucketReadWrite extends Binding.Service<
  BucketReadWrite,
  (bucket: R2Bucket) => Effect.Effect<ReadWriteBucketClient>
>()("Cloudflare.R2Bucket") {}

export const ReadWriteBucket = BucketReadWrite.bind;

export interface ReadWriteBucketClient
  extends ReadBucketClient, WriteBucketClient {}
