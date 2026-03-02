import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";

export class HeadObject extends Binding.Service<
  HeadObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<(key: string) => Effect.Effect<runtime.R2Object | null>>
>()("Cloudflare.R2.HeadObject") {}

export const HeadObjectLive = Layer.effect(
  HeadObject,
  Effect.gen(function* () {
    const Policy = yield* HeadObjectPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (key: string) {
        return yield* Effect.promise(() => r2Bucket.head(key));
      });
    });
  }),
);

export class HeadObjectPolicy extends Binding.Policy<
  HeadObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.HeadObject") {}

export const HeadObjectPolicyLive =
  HeadObjectPolicy.layer.succeed(BucketBinding);
