import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { declare, type To } from "../../policy.ts";
import { getCloudflareEnvKey } from "../context.ts";
import { Bind } from "./bucket.binding.ts";
import type { Bucket } from "./bucket.ts";

export const getR2BucketFromEnv = Effect.fnUntraced(function* <
  B extends Bucket,
>(bucket: B) {
  yield* declare<Bind<To<B>>>();
  return yield* getCloudflareEnvKey<runtime.R2Bucket>(bucket.id);
});

export type UploadValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | runtime.Blob
  | runtime.ReadableStream
  | Stream.Stream<any>;
