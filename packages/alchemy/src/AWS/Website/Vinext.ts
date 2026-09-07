import type { InputProps } from "../../Input.ts";
import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Bucket } from "../S3/Bucket.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The vinext-on-AWS framework module (it is its own deploy target — not
 * OpenNext, not the Cloudflare Worker source).
 */
export const VINEXT_AWS_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/aws";

/** The AWS Lambda deploy target for the vinext build. */
export const VINEXT_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/aws";

/** Env var the S3 data-cache adapter reads for the ISR/fetch cache bucket. */
export const VINEXT_CACHE_BUCKET_ENV = "CACHE_BUCKET_NAME";

export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a [vinext](https://vinext.dev) application to AWS: the RSC
 * server on a streaming Lambda Function URL, static assets in S3, and a
 * CloudFront distribution whose edge router serves uploaded files from S3
 * and forwards everything else to the server.
 *
 * ISR / `"use cache"` persistence is an S3 bucket (not Cloudflare KV).
 * This resource provisions the bucket, sets `CACHE_BUCKET_NAME`, and
 * grants the Lambda Get/Put/Delete/List. Spread `alchemy()` into
 * `vinext({ ...alchemy() })` — the AWS build bakes the S3 adapter.
 * A dedicated cache bucket keeps the graph acyclic (the asset bucket
 * is bound to CloudFront).
 *
 * This is **not** `AWS.Website.Nextjs` (OpenNext) and **not**
 * `Cloudflare.Website.Vinext`. During `alchemy dev` the site is
 * `vinext dev` and no cloud resources are declared.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* AWS.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** vite.config.ts (platform-agnostic)
 * ```typescript
 * import { alchemy } from "@alchemy.run/frontend-frameworks/vinext/cache";
 * import vinext from "vinext";
 *
 * export default defineConfig({
 *   plugins: [vinext({ prerender: true, ...alchemy() })],
 * });
 * ```
 *
 * @resource
 * @product Website
 * @category Frontend
 */
export const Vinext = (id: string, propsIn: InputProps<VinextProps> = {}) =>
  Effect.gen(function* () {
    const props = propsIn as VinextProps;
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;

    if (isLocal) {
      return {
        ...(yield* makeFrameworkSite(id, props, {
          name: "Vinext",
          framework: VINEXT_AWS_FRAMEWORK_SPECIFIER,
          target: VINEXT_AWS_TARGET_SPECIFIER,
        })),
        cacheBucket: undefined,
      };
    }

    const cacheBucket = yield* Bucket("CacheBucket", {
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    });
    const site = yield* makeFrameworkSite(
      id,
      {
        ...props,
        env: {
          [VINEXT_CACHE_BUCKET_ENV]: cacheBucket.bucketName,
          ...props.env,
        },
      },
      {
        name: "Vinext",
        framework: VINEXT_AWS_FRAMEWORK_SPECIFIER,
        target: VINEXT_AWS_TARGET_SPECIFIER,
      },
    );
    if (site.server !== undefined) {
      yield* site.server
        .bind`Allow(${site.server}, AWS.Website.Vinext.Cache(${cacheBucket}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: [Output.interpolate`${cacheBucket.bucketArn}/*` as never],
          },
          {
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [cacheBucket.bucketArn as never],
          },
        ] satisfies PolicyStatement[],
      });
    }
    return { ...site, cacheBucket };
  }).pipe(Namespace.push(id));
