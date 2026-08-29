/**
 * HTTP-backed implementation of {@link PresignedUrl} for hosts that
 * can't use Cloudflare Worker bindings (Lambda, ECS, Node servers).
 *
 * SigV4 query-string signing is identical to the Worker-binding path —
 * it's pure client-side computation. The only difference is where
 * the credentials come from: at Layer build time, we read them from
 * the environment. Workers get `secret_text` bindings (set up by
 * {@link PresignedUrlBinding}); non-Worker hosts just resolve the
 * env vars directly.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readR2PresignEnvCredentials } from "./R2PresignAuth.ts";
import { PresignedUrl, type PresignedUrlService } from "./PresignedUrl.ts";
import { makePresignedUrlClient } from "./PresignedUrlCore.ts";
import type { Bucket } from "./Bucket.ts";

export const PresignedUrlHttp: Layer.Layer<PresignedUrlService> = Layer.effect(
  PresignedUrl,
  Effect.gen(function* () {
    const credentials = yield* Effect.orDie(readR2PresignEnvCredentials());
    return Effect.fn(function* (bucket: Bucket) {
      // `bucket.bucketName` arrives as `Output<string>` (Binding.Service
      // wraps each parameter). The Output's iterator protocol yields
      // an Accessor Effect; yielding that yields the plain value.
      const accessor = yield* bucket.bucketName as unknown as {
        [Symbol.iterator]: () => Iterator<
          Effect.Effect<void, never, never>,
          Effect.Effect<string, never, never>,
          unknown
        >;
      };
      const bucketName = yield* accessor as unknown as Effect.Effect<
        string,
        never,
        never
      >;
      return makePresignedUrlClient(credentials, bucketName);
    });
  }),
);
