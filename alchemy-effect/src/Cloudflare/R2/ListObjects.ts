import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";

export interface ListObjectsOptions extends runtime.R2ListOptions {}

export class ListObjects extends Binding.Service<
  ListObjects,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (options?: ListObjectsOptions) => Effect.Effect<runtime.R2Objects>
  >
>()("Cloudflare.R2.ListObjects") {}

export const ListObjectsLive = Layer.effect(
  ListObjects,
  Effect.gen(function* () {
    const Policy = yield* ListObjectsPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (options?: ListObjectsOptions) {
        return yield* Effect.promise(() => r2Bucket.list(options));
      });
    });
  }),
);

export class ListObjectsPolicy extends Binding.Policy<
  ListObjectsPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.ListObjects") {}

export const ListObjectsPolicyLive = Layer.effect(
  ListObjectsPolicy,
  BucketBinding,
);
