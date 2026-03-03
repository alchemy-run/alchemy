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

export class ResumeMultipartUpload extends Binding.Service<
  ResumeMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (key: string, uploadId: string) => Effect.Effect<MultipartUploadClient>
  >
>()("Cloudflare.R2.ResumeMultipartUpload") {}

export const ResumeMultipartUploadLive = Layer.effect(
  ResumeMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* ResumeMultipartUploadPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (key: string, uploadId: string) {
        const multipartUpload = r2Bucket.resumeMultipartUpload(key, uploadId);
        return makeMultipartUploadClient(multipartUpload);
      });
    });
  }),
);

export class ResumeMultipartUploadPolicy extends Binding.Policy<
  ResumeMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.ResumeMultipartUpload") {}

export const ResumeMultipartUploadPolicyLive =
  ResumeMultipartUploadPolicy.layer.succeed(BucketBinding);
