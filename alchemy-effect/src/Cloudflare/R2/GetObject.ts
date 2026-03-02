import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";

export interface GetObjectOptions extends runtime.R2GetOptions {}

export class GetObject extends Binding.Service<
  GetObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      key: string,
      options?: GetObjectOptions,
    ) => Effect.Effect<runtime.R2ObjectBody | null>
  >
>()("Cloudflare.R2.GetObject") {}

export const GetObjectLive = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const Policy = yield* GetObjectPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (key: string, options?: GetObjectOptions) {
        return yield* Effect.promise(() => r2Bucket.get(key, options));
      });
    });
  }),
);

export class GetObjectPolicy extends Binding.Policy<
  GetObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.GetObject") {}

export const GetObjectPolicyLive = GetObjectPolicy.layer.succeed(BucketBinding);
