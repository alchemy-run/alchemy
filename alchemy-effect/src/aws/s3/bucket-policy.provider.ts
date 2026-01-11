import * as Effect from "effect/Effect";

import { BucketPolicy } from "./bucket-policy.ts";
import * as s3 from "distilled-aws/s3";

export const bucketPolicyProvider = () =>
  BucketPolicy.provider.effect(
    Effect.gen(function* () {
      return {
        stables: ["bucket"],
        diff: Effect.fn(function* ({ news, olds }) {
          // Bucket change requires replacement
          if (olds.bucket !== news.bucket) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ news, session }) {
          const bucket = news.bucket as string;

          yield* s3
            .putBucketPolicy({
              Bucket: bucket,
              Policy: JSON.stringify(news.policy),
            })
            .pipe(Effect.orDie);

          yield* session.note(`Applied policy to bucket: ${bucket}`);

          return {
            bucket,
          };
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* s3
            .putBucketPolicy({
              Bucket: output.bucket,
              Policy: JSON.stringify(news.policy),
            })
            .pipe(Effect.orDie);

          yield* session.note(`Updated policy on bucket: ${output.bucket}`);
          return output;
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* s3
            .deleteBucketPolicy({
              Bucket: output.bucket,
            })
            .pipe(
              Effect.catchTag("NoSuchBucket", () => Effect.void),
              Effect.orDie,
            );

          yield* session.note(`Removed policy from bucket: ${output.bucket}`);
        }),
      };
    }),
  );
