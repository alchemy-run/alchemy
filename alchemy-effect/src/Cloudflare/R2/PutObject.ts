import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import { replaceEffectStream } from "../stream.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";
import type { UploadValue } from "./UploadValue.ts";

export interface PutObjectOptions extends runtime.R2PutOptions {}

export class PutObject extends Binding.Service<
  PutObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      key: string,
      value: UploadValue,
      options?: PutObjectOptions,
    ) => Effect.Effect<runtime.R2Object | null>
  >
>()("Cloudflare.R2.PutObject") {}

export const PutObjectLive = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const Policy = yield* PutObjectPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];
      return Effect.fn(function* (
        key: string,
        value: UploadValue,
        options?: PutObjectOptions,
      ) {
        return yield* Effect.promise(() =>
          r2Bucket.put(key, replaceEffectStream(value), options),
        );
      });
    });
  }),
);

export class PutObjectPolicy extends Binding.Policy<
  PutObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.PutObject") {}

export const PutObjectPolicyLive = PutObjectPolicy.layer.succeed(BucketBinding);
