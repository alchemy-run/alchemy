import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";

export class DeleteObject extends Binding.Service<
  DeleteObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<(keys: string | string[]) => Effect.Effect<void>>
>()("Cloudflare.R2.DeleteObject") {}

export const DeleteObjectLive = Layer.effect(
  DeleteObject,
  Effect.gen(function* () {
    const Policy = yield* DeleteObjectPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (keys: string | string[]) {
        return yield* Effect.promise(() => r2Bucket.delete(keys));
      });
    });
  }),
);

export class DeleteObjectPolicy extends Binding.Policy<
  DeleteObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.DeleteObject") {}

export const DeleteObjectPolicyLive = Layer.effect(
  DeleteObjectPolicy,
  BucketBinding,
);
