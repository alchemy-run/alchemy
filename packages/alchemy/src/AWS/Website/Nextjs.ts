import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { Table } from "../DynamoDB/Table.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { EventSourceMapping } from "../Lambda/EventSourceMapping.ts";
import { Function as LambdaFunction } from "../Lambda/Function.ts";
import { Bucket } from "../S3/Bucket.ts";
import { Queue } from "../SQS/Queue.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import { Server } from "./Server.ts";
import {
  makeKvSite,
  type StaticSiteProps,
  type StaticSiteRouterAttachment,
} from "./StaticSite.ts";
import type {
  StaticSiteAssetsProps,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

/**
 * The framework-integration module that drives the `@opennextjs/aws` build
 * (it is its own deploy target — the module IS the AWS pipeline).
 */
export const NEXTJS_AWS_FRAMEWORK_SPECIFIER =
  "@alchemy.run/web-frameworks/nextjs/aws";

/** The S3 key prefix the OpenNext ISR/fetch cache seed is uploaded under. */
export const NEXTJS_CACHE_PREFIX = "_cache";

export interface NextjsProps {
  /**
   * Project root directory (the directory containing `next.config.ts`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * SSR server (Lambda) configuration.
   */
  server?: {
    /**
     * Memory allocated to the server function, in MB.
     * @default 1024
     */
    memorySize?: number;
    /**
     * Maximum request duration.
     * @default 30 seconds
     */
    timeout?: Duration.Duration;
    /**
     * Environment variables for the server function.
     */
    environment?: Record<string, any>;
    /**
     * Instruction set architecture.
     * @default "x86_64"
     */
    architecture?: "x86_64" | "arm64";
  };
  /**
   * Image optimization (Lambda) configuration.
   */
  imageOptimization?: {
    /**
     * Memory allocated to the image optimization function, in MB.
     * @default 1536
     */
    memorySize?: number;
  };
  /**
   * Static asset upload configuration.
   */
  assets?: StaticSiteAssetsProps & {
    fileOptions?: AssetFileOption[];
  };
  /**
   * Optional custom domain.
   */
  domain?: string | WebsiteDomainProps;
  /**
   * Serve this site through an existing `AWS.Website.Router` instead of a
   * standalone CloudFront distribution.
   */
  router?: StaticSiteRouterAttachment;
  /**
   * Additional CloudFront Function customizations.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Optional deterministic S3 bucket name for the asset bucket.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * CloudFront invalidation behavior.
   * @default { paths: "all", wait: false }
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

/**
 * Deploy a Next.js application to AWS with the OpenNext
 * (`@opennextjs/aws`) serverless topology: the SSR server on a streaming
 * Lambda Function URL, static assets in S3 behind CloudFront's KV-manifest
 * edge router, the ISR/fetch cache in the same bucket, a dedicated image
 * optimization Lambda routed at `/_next/image`, and ISR revalidation
 * through an SQS FIFO queue plus a DynamoDB tag-cache table.
 *
 * The build runs through `@alchemy.run/web-frameworks/nextjs/aws` (the
 * `@opennextjs/aws` pipeline) — both it and `@opennextjs/aws` must be
 * installed in your project. When the project has no `open-next.config.ts`,
 * a minimal default with the streaming server wrapper is generated.
 *
 * During `alchemy dev` the site is Next's own dev server (`next dev`) and
 * no cloud resources are declared; `Alchemy.remote()` opts back into the
 * full live deployment.
 *
 * @resource
 * @section Creating Next.js Sites
 * @example Basic Next.js App
 * ```typescript
 * const site = yield* AWS.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * @section Server Configuration
 * @example Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   server: {
 *     memorySize: 2048,
 *     environment: {
 *       API_BASE: api.url,
 *     },
 *   },
 * });
 * ```
 */
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    // Mirrors the other Website composites: during `alchemy dev` the site
    // is `next dev` (native HMR) and no cloud resources are declared;
    // `Alchemy.remote()` opts back into the full live deployment.
    const isLocal = ctx.dev && remoted !== true;

    const build = yield* Server("Build", {
      framework: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
      target: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
      root: props.rootDir,
      memo: props.memo,
    });

    if (isLocal) {
      return {
        bucket: undefined,
        build,
        cacheFiles: undefined,
        distribution: undefined,
        files: undefined,
        imageFunction: undefined,
        imageUrl: undefined,
        invalidation: undefined,
        kvNamespace: undefined,
        revalidationFunction: undefined,
        revalidationQueue: undefined,
        server: undefined,
        serverUrl: undefined,
        tagCacheTable: undefined,
        url: build.url,
      };
    }

    // `.open-next/<relative>` derived from the build's dist directory.
    const fromDist = (relative: string) =>
      Output.map((dir: string | undefined) => {
        if (!dir) {
          throw new Error(
            "The Next.js build produced no .open-next directory.",
          );
        }
        return `${dir}/${relative}`;
      })(build.distDir as any) as Input<string>;

    // The asset bucket also holds the ISR/fetch cache (under
    // `_cache/`), read and written by the server function.
    const bucket =
      props.assets?.bucket ??
      (yield* Bucket("Bucket", {
        bucketName: props.bucketName,
        forceDestroy: props.forceDestroy,
        tags: props.tags,
      }));

    // ISR revalidation queue: OpenNext's `sqs` queue override sends
    // explicitly-deduplicated messages to a FIFO queue.
    const revalidationQueue = yield* Queue("RevalidationQueue", {
      fifo: true,
      // Lambda requires the queue's visibility timeout to cover the
      // consumer function's timeout (30s) with headroom.
      visibilityTimeout: "2 minutes",
      tags: props.tags,
    });

    // Tag cache (`revalidateTag` / `revalidatePath`): the schema OpenNext's
    // `dynamodb` tag-cache override queries — `tag`/`path` primary key plus
    // the `revalidate` GSI on `path`/`revalidatedAt`.
    const tagCacheTable = yield* Table("TagCache", {
      partitionKey: "tag",
      sortKey: "path",
      attributes: { tag: "S", path: "S", revalidatedAt: "N" },
      globalSecondaryIndexes: [
        {
          IndexName: "revalidate",
          KeySchema: [
            { AttributeName: "path", KeyType: "HASH" },
            { AttributeName: "revalidatedAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      billingMode: "PAY_PER_REQUEST",
      tags: props.tags,
    });

    const server = yield* LambdaFunction("Server", {
      main: fromDist("server-functions/default/index.mjs"),
      handler: "handler",
      isExternal: true,
      // OpenNext's server-functions/default is a complete deployment unit
      // (entry + traced .next output + its own node_modules) — ship as-is.
      bundle: false,
      runtime: "nodejs22.x",
      architecture: props.server?.architecture,
      memorySize: props.server?.memorySize ?? 1024,
      timeout: props.server?.timeout ?? Duration.seconds(30),
      env: {
        // The env names OpenNext's s3/sqs/dynamodb overrides read. Regions
        // are omitted: the SDK falls back to the Lambda runtime's own
        // AWS_REGION, and every resource here is same-region.
        CACHE_BUCKET_NAME: bucket.bucketName,
        CACHE_BUCKET_KEY_PREFIX: NEXTJS_CACHE_PREFIX,
        REVALIDATION_QUEUE_URL: revalidationQueue.queueUrl,
        CACHE_DYNAMO_TABLE: tagCacheTable.tableName,
        ...props.server?.environment,
      },
      url: {
        authType: "NONE",
        // The default server is built with the aws-lambda-streaming
        // wrapper (the framework module enforces it).
        invokeMode: "RESPONSE_STREAM",
      },
    });

    yield* server.bind`Allow(${server}, AWS.Website.Nextjs.Cache(${bucket}))`({
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
        },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [bucket.bucketArn as any],
        },
        {
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [revalidationQueue.queueArn as any],
        },
        {
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:BatchGetItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:UpdateItem",
          ],
          Resource: [
            tagCacheTable.tableArn as any,
            Output.interpolate`${tagCacheTable.tableArn}/index/*` as any,
          ],
        },
      ] satisfies PolicyStatement[],
    });

    // ISR revalidation consumer: drains the FIFO queue and HEAD-requests
    // stale pages with the prerender revalidate header.
    const revalidationFunction = yield* LambdaFunction("Revalidation", {
      main: fromDist("revalidation-function/index.mjs"),
      handler: "handler",
      isExternal: true,
      bundle: false,
      runtime: "nodejs22.x",
      memorySize: 512,
      timeout: Duration.seconds(30),
      url: false,
    });

    yield* revalidationFunction.bind`Allow(${revalidationFunction}, AWS.SQS.Consume(${revalidationQueue}))`(
      {
        policyStatements: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
              "sqs:GetQueueUrl",
              "sqs:ChangeMessageVisibility",
            ],
            Resource: [revalidationQueue.queueArn as any],
          },
        ] satisfies PolicyStatement[],
      },
    );

    yield* EventSourceMapping("RevalidationEventSource", {
      functionName: revalidationFunction.functionName,
      eventSourceArn: revalidationQueue.queueArn,
      batchSize: 5,
    });

    // Image optimization: OpenNext installs sharp's linux-arm64 binaries
    // into the bundle, so the function architecture is always arm64. Its
    // s3 image loader reads originals from the asset bucket.
    const imageFunction = yield* LambdaFunction("ImageOptimization", {
      main: fromDist("image-optimization-function/index.mjs"),
      handler: "handler",
      isExternal: true,
      bundle: false,
      runtime: "nodejs22.x",
      architecture: "arm64",
      memorySize: props.imageOptimization?.memorySize ?? 1536,
      timeout: Duration.seconds(25),
      env: {
        BUCKET_NAME: bucket.bucketName,
      },
      url: {
        authType: "NONE",
        // The image optimizer is buffered (streaming: false in the
        // OpenNext output manifest).
        invokeMode: "BUFFERED",
      },
    });

    yield* imageFunction.bind`Allow(${imageFunction}, AWS.S3.GetObject(${bucket}))`(
      {
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
          },
        ] satisfies PolicyStatement[],
      },
    );

    const urlHost = (url: string | undefined) => {
      if (!url) {
        throw new Error(
          "A Next.js Lambda function did not produce a Function URL.",
        );
      }
      return new URL(url).hostname;
    };
    const serverHost = Output.map(urlHost)(
      server.functionUrl as any,
    ) as Input<string>;
    const imageHost = Output.map(urlHost)(
      imageFunction.functionUrl as any,
    ) as Input<string>;

    const siteProps: StaticSiteProps = {
      path: build.clientDir as unknown as string,
      assets: {
        ...props.assets,
        // Never purge: the ISR/fetch cache lives in the same bucket (under
        // `_cache/`), and the site's asset deployment purges from the
        // bucket ROOT — a purge would delete the cache (and in-flight
        // requests' previous-deploy hashed chunks).
        purge: false,
      },
      domain: props.domain,
      router: props.router,
      edge: props.edge,
      bucketName: props.bucketName,
      forceDestroy: props.forceDestroy,
      invalidation: props.invalidation,
      tags: props.tags,
    };

    const site = yield* makeKvSite(id, siteProps, {
      serverHost,
      image: { route: "/_next/image", host: imageHost },
    });

    // Seed the ISR/fetch cache: `.open-next/cache/<buildId>/...` uploaded
    // under `_cache/` (matching CACHE_BUCKET_KEY_PREFIX). Old builds' seeds
    // are left in place so a rolling deploy never breaks in-flight ISR.
    const cacheFiles = yield* AssetDeployment("CacheFiles", {
      bucket,
      sourcePath: fromDist("cache") as unknown as string,
      prefix: NEXTJS_CACHE_PREFIX,
      purge: false,
    });

    return {
      ...site,
      build,
      cacheFiles,
      imageFunction,
      imageUrl: imageFunction.functionUrl,
      revalidationFunction,
      revalidationQueue,
      server,
      serverUrl: server.functionUrl,
      tagCacheTable,
    };
  }).pipe(Namespace.push(id));
