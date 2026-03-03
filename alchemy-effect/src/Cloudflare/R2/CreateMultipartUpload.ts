import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";
import {
  type MultipartUploadClient,
  makeMultipartUploadClient,
} from "./MultipartUploadClient.ts";

export interface CreateMultipartUploadOptions
  extends runtime.R2MultipartOptions {}

export class CreateMultipartUpload extends Binding.Service<
  CreateMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      key: string,
      options?: CreateMultipartUploadOptions,
    ) => Effect.Effect<MultipartUploadClient>
  >
>()("Cloudflare.R2.CreateMultipartUpload") {}

export const CreateMultipartUploadLive = Layer.effect(
  CreateMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* CreateMultipartUploadPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (
        key: string,
        options?: CreateMultipartUploadOptions,
      ) {
        const multipartUpload = yield* Effect.promise(() =>
          r2Bucket.createMultipartUpload(key, options),
        );
        return makeMultipartUploadClient(multipartUpload);
      });
    });
  }),
);

export class CreateMultipartUploadPolicy extends Binding.Policy<
  CreateMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.CreateMultipartUpload") {}

export const CreateMultipartUploadPolicyLive =
  CreateMultipartUploadPolicy.layer.succeed(BucketBinding);
