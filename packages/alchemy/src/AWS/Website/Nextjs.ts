import type { ConfigError } from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { Input } from "../../Input.ts";
import type { Named, Tag } from "../../Named.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Distribution } from "../CloudFront/Distribution.ts";
import type { Invalidation } from "../CloudFront/Invalidation.ts";
import { Table } from "../DynamoDB/Table.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { EventSourceMapping } from "../Lambda/EventSourceMapping.ts";
import {
  Function as LambdaFunction,
  type FunctionProps,
  type FunctionServices,
  type FunctionTypeId,
} from "../Lambda/Function.ts";
import type { Providers } from "../Providers.ts";
import { Bucket } from "../S3/Bucket.ts";
import { Queue } from "../SQS/Queue.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import { AWSEnvironment } from "../Environment.ts";
import { CurrentRegion } from "../Region.ts";
import {
  attachLambdaServeShell,
  compileServerRoutes,
  DEFAULT_SERVER_ROUTES,
  deploySiblingHandlers,
  validateImplAnchor,
  type WebsiteServerOptions,
  type WebsiteShape,
} from "./Effectful.ts";
import { effectServerFunctionProps } from "./FrameworkSite.ts";
import { Server, type ServerDevProps } from "./Server.ts";
import { makeKvSite, type StaticSiteProps } from "./StaticSite.ts";
import type {
  WebsiteAssetsConfig,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

/**
 * The framework-integration module that drives the `@opennextjs/aws` build
 * (it is its own deploy target — the module IS the AWS pipeline).
 */
export const NEXTJS_AWS_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/nextjs/aws";

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
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
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
    /**
     * Lambda runtime for the server function.
     * @default "nodejs24.x"
     */
    runtime?: FunctionProps["runtime"];
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
  assets?: WebsiteAssetsConfig;
  /**
   * Optional custom domain. A string is shorthand for `{ name }`; `null`
   * explicitly clears a previously set domain. Set `domain.router` to
   * serve the site through an existing `AWS.Website.Router` instead of a
   * standalone CloudFront distribution.
   */
  domain?: string | WebsiteDomainProps | null;
  /**
   * Serve the site at its CloudFront default domain
   * (`https://dxxxx.cloudfront.net`). `false` 301s default-domain requests
   * to `https://<domain.name>` at the edge and excludes the default domain
   * from the `urls` output. Requires `domain`; not applicable when
   * `domain.router` is set.
   * @default true
   */
  cloudfrontUrl?: boolean;
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
 * Props for the effectful `Nextjs` arms — today's props plus the required
 * `main` module anchor and the widened `server` options.
 */
export interface EffectNextjsProps extends NextjsProps {
  /**
   * The module URL default-exporting this class (`main: import.meta.url`).
   * Required with an impl: the OpenNext-built server bundle re-imports the
   * program by path (the `alchemy/serve/next` route-handler mount).
   */
  main: string;
  /**
   * Server routing + delivery + Lambda tuning (`server.routes` defaults to
   * `["/api/*"]`).
   */
  server?: NextjsProps["server"] & WebsiteServerOptions;
}

/**
 * The attributes a deployed `Nextjs` site resolves to. In dev mode
 * (`alchemy dev`) the cloud-resource attributes are `undefined` and `url`
 * is `next dev`'s own address.
 */
export interface NextjsAttributes {
  /** The CDN-facing asset bucket (`undefined` in dev). */
  bucket: Bucket | undefined;
  /** The OpenNext build (`AWS.Website.Server`). */
  build: Server;
  /** The dedicated ISR/fetch cache bucket (`undefined` in dev). */
  cacheBucket: Bucket | undefined;
  /** The uploaded ISR/fetch cache seed (`undefined` in dev). */
  cacheFiles: AssetDeployment | undefined;
  /** The standalone CloudFront distribution (`undefined` in dev and for Router-attached sites). */
  distribution: Distribution | undefined;
  /** The uploaded asset deployment (`undefined` in dev). */
  files: AssetDeployment | undefined;
  /** The image optimization Lambda (`undefined` in dev). */
  imageFunction: LambdaFunction | undefined;
  /** The image optimization Lambda's Function URL. */
  imageUrl: Input<string | undefined> | undefined;
  /** The CloudFront invalidation issued for this deployment, if enabled. */
  invalidation: Invalidation | undefined;
  /** The site's namespace prefix in the CloudFront KeyValueStore. */
  kvNamespace: string | undefined;
  /** The ISR revalidation consumer Lambda (`undefined` in dev). */
  revalidationFunction: LambdaFunction | undefined;
  /** The ISR revalidation FIFO queue (`undefined` in dev). */
  revalidationQueue: Queue | undefined;
  /** The SSR server Lambda (`undefined` in dev). */
  server: LambdaFunction | undefined;
  /** The server Lambda's Function URL. */
  serverUrl: Input<string | undefined> | undefined;
  /** The DynamoDB tag-cache table (`undefined` in dev). */
  tagCacheTable: Table | undefined;
  /** The most significant URL the site serves at — always `urls[0]`. */
  url: Input<string | undefined>;
  /** Every URL that serves this site, most significant first. */
  urls: Input<string | undefined>[];
}

/**
 * Attributes of an effectful `Nextjs` site: the site attributes with the
 * server Lambda always present — in dev it is the locally-emulated effect
 * Lambda, on deploy the collect-only OpenNext server Lambda.
 */
export interface EffectNextjsAttributes extends NextjsAttributes {
  /** The effect-carrying server Lambda. */
  server: LambdaFunction;
  /** The server Lambda's Function URL. */
  serverUrl: Input<string | undefined>;
}

/**
 * Deploy a Next.js application to AWS with the OpenNext
 * (`@opennextjs/aws`) serverless topology: the SSR server on a streaming
 * Lambda Function URL, static assets in S3 behind CloudFront's KV-manifest
 * edge router, the ISR/fetch cache in a dedicated S3 bucket, a dedicated
 * image optimization Lambda routed at `/_next/image`, and ISR revalidation
 * through an SQS FIFO queue plus a DynamoDB tag-cache table.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/nextjs/aws` (the
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
 *
 * @section Effectful Site
 * Pass an Effect program as the third argument to serve an effect-native
 * API from the same site: the program threads into the OpenNext server
 * Lambda in collect-only mode (bindings collect env vars and IAM at deploy
 * time) while the OpenNext-built bundle ships as-is, and the CloudFront
 * edge router forwards `server.routes` (default `["/api/*"]`) to the
 * server BEFORE the static-asset manifest. The program must live in a
 * dedicated module whose default export is the class
 * (`main: import.meta.url`) and be mounted via the `alchemy/serve/next`
 * catch-all route handler (`app/api/[[...slug]]/route.ts`).
 *
 * @example Next.js site with an effect-native API
 * ```typescript
 * // src/site.ts — narrow subpath imports keep the IaC engine out of the
 * // Next bundle graph; never import the `alchemy/AWS` provider barrel
 * // from a site module.
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { Nextjs } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends Nextjs<Site>()(
 *   "Site",
 *   { main: import.meta.url, server: { routes: ["/api/*"] } },
 *   Effect.gen(function* () {
 *     const getObject = yield* GetObject(yield* Data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://localhost");
 *         if (url.pathname === "/api/hello") {
 *           const object = yield* getObject({ Key: "hello.txt" }).pipe(
 *             Effect.orDie,
 *           );
 *           return HttpServerResponse.text(String(object.Body));
 *         }
 *         return yield* HttpServerResponse.json(
 *           { error: "unknown api route" },
 *           { status: 404 },
 *         );
 *       }),
 *     };
 *   }).pipe(Effect.provide(GetObjectHttp)),
 * ) {}
 * ```
 *
 * @example Mounting the program (app/api/[[...slug]]/route.ts)
 * The catch-all route handler is compiled by Next itself, so it runs in
 * `next build` output and `next dev` alike. Next's router prefers more
 * specific routes, so your own route handlers (e.g. `app/api/hello/route.ts`)
 * keep winning over the catch-all.
 * ```typescript
 * import { toRouteHandler } from "alchemy/serve/next";
 * import Site from "../../../src/site.ts";
 *
 * const handler = toRouteHandler(Site);
 * export { handler as GET, handler as POST, handler as PUT,
 *          handler as PATCH, handler as DELETE, handler as HEAD,
 *          handler as OPTIONS };
 * ```
 */
export const Nextjs: {
  <Self>(): {
    <
      const Id extends string,
      Shape extends WebsiteShape,
      InitReq extends FunctionServices | PlatformServices | LambdaFunction =
        never,
    >(
      id: Id,
      props: EffectNextjsProps,
      impl: Effect.Effect<Shape, ConfigError, InitReq>,
    ): Effect.Effect<
      EffectNextjsAttributes,
      never,
      | Providers
      | Exclude<InitReq, FunctionServices | PlatformServices | LambdaFunction>
    > &
      Named<Id> & {
        new (): MakeShape<Shape, WebsiteShape> &
          Named<Id> &
          Tag<FunctionTypeId>;
      };
    (
      id: string,
      props?: NextjsProps,
    ): Effect.Effect<NextjsAttributes, never, Providers> & {
      new (): NextjsAttributes;
    };
  };
  <
    const Id extends string,
    Shape extends WebsiteShape,
    InitReq extends FunctionServices | PlatformServices | LambdaFunction =
      never,
  >(
    id: Id,
    props: EffectNextjsProps,
    impl: Effect.Effect<Shape, ConfigError, InitReq>,
  ): Effect.Effect<
    EffectNextjsAttributes,
    never,
    | Providers
    | Exclude<InitReq, FunctionServices | PlatformServices | LambdaFunction>
  > &
    Named<Id>;
  (
    id: string,
    props?: NextjsProps,
  ): Effect.Effect<NextjsAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        // The class carries the AWS serve shell so `Serve.make(Site)` (and
        // the `toRouteHandler` mount built on it) dispatches through the
        // Lambda/Node layer recipe instead of the Cloudflare bridge.
        attachLambdaServeShell(effectClass(makeNextjs(id, props, impl)))
    : makeNextjs(id, props, impl)) as any;

const makeNextjs = (
  id: string,
  props: NextjsProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  Effect.gen(function* () {
    // Runtime world: the deployed OpenNext bundle's `alchemy/serve/next`
    // mount re-imports this module's default export and re-evaluates the
    // program inside the Lambda — delegate straight to the Lambda platform
    // call, which owns the runtime re-evaluation contract.
    if (impl !== undefined && globalThis.__ALCHEMY_RUNTIME__) {
      return yield* (LambdaFunction as any)(
        id,
        effectServerFunctionProps(props as EffectNextjsProps),
        impl,
      ) as Effect.Effect<any, never, any>;
    }
    let routes: readonly string[] | undefined;
    let anchoredImpl = impl;
    if (impl !== undefined) {
      yield* validateImplAnchor(
        id,
        "Nextjs",
        (props as EffectNextjsProps).main,
      );
      routes =
        (props as EffectNextjsProps).server?.routes ?? DEFAULT_SERVER_ROUTES;
      // Validate the route globs eagerly — a plan-time defect even in dev,
      // where the edge compile never runs.
      yield* compileServerRoutes(id, routes);
      // Impl-declared resources register at the CALLER's namespace —
      // CF-Worker / effectful-StaticSite parity (the migration contract:
      // moving an effect Worker's body into the Website class must not
      // move its resources' FQNs). The composite's internal
      // `Namespace.push(id)` is an implementation detail that must not
      // leak into the user's program.
      const callerNamespace = yield* Namespace.CurrentNamespace;
      anchoredImpl = Effect.provideService(
        impl,
        Namespace.Namespace,
        callerNamespace as Namespace.NamespaceNode,
      );
    }
    return yield* makeNextjsSite(id, props, anchoredImpl, routes).pipe(
      Namespace.push(id),
    );
  });

const makeNextjsSite = Effect.fn("AWS.Website.Nextjs")(function* (
  id: string,
  props: NextjsProps,
  impl: Effect.Effect<any, any, any> | undefined,
  routes: readonly string[] | undefined,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  // Mirrors the other Website composites: during `alchemy dev` the site
  // is `next dev` (native HMR) and no cloud resources are declared;
  // `Alchemy.remote()` opts back into the full live deployment.
  const isLocal = ctx.dev && remoted !== true;

  if (isLocal) {
    // Effectful dev: the effect program deploys into the local Lambda
    // emulator (the sibling function) and the collected env map — plus the
    // alchemy stack markers the in-process `alchemy/serve` mount needs —
    // is lowered into the dev `Server` resource's env, which applies it to
    // the `next dev` process environment.
    const server =
      impl !== undefined
        ? ((yield* (LambdaFunction as any)(
            "Server",
            effectServerFunctionProps(props as EffectNextjsProps),
            impl,
          ) as Effect.Effect<any, never, any>) as LambdaFunction)
        : undefined;
    const devEnv =
      impl !== undefined
        ? yield* Effect.gen(function* () {
            // `AWS_REGION` mirrors the Lambda sandbox (which always
            // provides it): the serve mount's capability clients resolve
            // `Region.fromEnv()`, so the `next dev` process needs the
            // engine's resolved region. `AWS_PROFILE` (when the engine
            // authenticated through a profile) points the mount's
            // `Credentials.fromChain()` at the SAME AWS profile the engine
            // used — the AWS dev model: bindings hit real cloud, so
            // capability resources are typically piped through
            // `Alchemy.remote()` under `alchemy dev`.
            const awsEnv = yield* AWSEnvironment.current;
            return {
              AWS_REGION: yield* CurrentRegion,
              ...(awsEnv.profile !== undefined
                ? { AWS_PROFILE: awsEnv.profile }
                : {}),
              ...props.server?.environment,
              ...((server as any)?.Props?.env ?? {}),
              ALCHEMY_STACK_NAME: (yield* Stack).name,
              ALCHEMY_STAGE: yield* Stage,
            };
          })
        : props.server?.environment;

    const build = yield* Server("Build", {
      framework: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
      target: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
      root: props.rootDir,
      env: devEnv as any,
      memo: props.memo,
      dev: props.dev,
    });

    return {
      bucket: undefined,
      build,
      cacheBucket: undefined,
      cacheFiles: undefined,
      distribution: undefined,
      files: undefined,
      imageFunction: undefined,
      imageUrl: undefined,
      invalidation: undefined,
      kvNamespace: undefined,
      revalidationFunction: undefined,
      revalidationQueue: undefined,
      server,
      serverUrl: server?.functionUrl as Input<string | undefined> | undefined,
      tagCacheTable: undefined,
      url: build.url,
      urls: [build.url],
    };
  }

  const build = yield* Server("Build", {
    framework: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
    target: NEXTJS_AWS_FRAMEWORK_SPECIFIER,
    root: props.rootDir,
    env: props.server?.environment,
    memo: props.memo,
    dev: props.dev,
  });

  // `.open-next/<relative>` derived from the build's dist directory.
  const fromDist = (relative: string) =>
    Output.map((dir: string | undefined) => {
      if (!dir) {
        throw new Error("The Next.js build produced no .open-next directory.");
      }
      return `${dir}/${relative}`;
    })(build.distDir as any) as Input<string>;

  // The CDN-facing asset bucket (site assets + public files + originals
  // for the image optimizer).
  const bucket =
    props.assets?.bucket ??
    (yield* Bucket("Bucket", {
      bucketName: props.bucketName,
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    }));

  // The ISR/fetch cache lives in its OWN bucket, deliberately separate
  // from the site bucket: the site bucket carries the CloudFront read
  // policy (bound to the distribution's ARN), so a server -> site-bucket
  // reference would close a dependency cycle
  // (server -> bucket -> distribution -> server) and force the CloudFront
  // origin to rendezvous on the Lambda's precreate stub, which has no
  // Function URL yet. A dedicated cache bucket keeps the graph acyclic.
  const cacheBucket = yield* Bucket("CacheBucket", {
    forceDestroy: props.forceDestroy,
    tags: props.tags,
  });

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

  const serverProps = {
    // The framework module derives the entry from open-next.output.json
    // (origins.default.bundle + handler), so this tracks the manifest.
    main: build.serverEntry as unknown as string,
    handler: "handler",
    // OpenNext's server-functions/default is a complete deployment unit
    // (entry + traced .next output + its own node_modules) — ship as-is.
    bundle: false as const,
    runtime: props.server?.runtime ?? "nodejs24.x",
    architecture: props.server?.architecture,
    memorySize: props.server?.memorySize ?? 1024,
    timeout: props.server?.timeout ?? Duration.seconds(30),
    env: {
      // The env names OpenNext's s3/sqs/dynamodb overrides read. Regions
      // are omitted: the SDK falls back to the Lambda runtime's own
      // AWS_REGION, and every resource here is same-region.
      CACHE_BUCKET_NAME: cacheBucket.bucketName,
      CACHE_BUCKET_KEY_PREFIX: NEXTJS_CACHE_PREFIX,
      REVALIDATION_QUEUE_URL: revalidationQueue.queueUrl,
      CACHE_DYNAMO_TABLE: tagCacheTable.tableName,
      ...props.server?.environment,
    },
    functionUrl: {
      authType: "NONE" as const,
      // The default server is built with the aws-lambda-streaming
      // wrapper (the framework module enforces it).
      invokeMode: "RESPONSE_STREAM" as const,
    },
  };

  // Sibling-function non-fetch delivery (DESIGN §2.1.3): the OpenNext
  // entry is pre-streamified, so event-source handlers cannot ride it.
  // Deploy the same impl as a sibling effect Lambda FIRST (its event
  // sources register mappings + IAM against the sibling; fetch-only impls
  // retract it), then thread the redirect-wrapped impl into the site
  // Lambda.
  const siteImpl =
    impl !== undefined
      ? (yield* deploySiblingHandlers({
          id,
          main: (props as EffectNextjsProps).main,
          impl,
          runtime: props.server?.runtime,
          architecture: props.server?.architecture,
          memorySize: props.server?.memorySize,
          timeout: props.server?.timeout,
          env: props.server?.environment,
        })).siteImpl
      : undefined;

  // With an Effect program, the server Lambda runs in collect-only mode:
  // the impl's init evaluates at plan time (bindings collect env + IAM
  // through `attachBindings`) while the OpenNext artifact ships as-is;
  // `finalizeFunctionProps` stamps `runtimeDelivery` and the deploy-time
  // sentinel scan enforces the `alchemy/serve` mount. Next.js AWS is
  // explicit-tier by design (the emitted entry is pre-streamified — there
  // is no pre-streamify fetch seam to wrap; DESIGN §2.1.3).
  const server =
    siteImpl !== undefined
      ? ((yield* (LambdaFunction as any)(
          "Server",
          {
            ...serverProps,
            server: {
              routes: [...(routes ?? DEFAULT_SERVER_ROUTES)],
              verify: (props as EffectNextjsProps).server?.verify,
              takeover: (props as EffectNextjsProps).server?.takeover,
            },
            runtimeDelivery: "external",
          },
          siteImpl,
        ) as Effect.Effect<any, never, any>) as LambdaFunction)
      : yield* LambdaFunction("Server", { ...serverProps, isExternal: true });

  yield* server.bind`Allow(${server}, AWS.Website.Nextjs.Cache(${cacheBucket}))`(
    {
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: [Output.interpolate`${cacheBucket.bucketArn}/*` as any],
        },
        {
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [cacheBucket.bucketArn as any],
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
    },
  );

  // ISR revalidation consumer: drains the FIFO queue and HEAD-requests
  // stale pages with the prerender revalidate header.
  const revalidationFunction = yield* LambdaFunction("Revalidation", {
    main: fromDist("revalidation-function/index.mjs"),
    handler: "handler",
    isExternal: true,
    bundle: false,
    runtime: "nodejs24.x",
    memorySize: 512,
    timeout: Duration.seconds(30),
    functionUrl: false,
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
    runtime: "nodejs24.x",
    architecture: "arm64",
    memorySize: props.imageOptimization?.memorySize ?? 1536,
    timeout: Duration.seconds(25),
    env: {
      BUCKET_NAME: bucket.bucketName,
    },
    functionUrl: {
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
    assets: props.assets,
    domain: props.domain,
    cloudfrontUrl: props.cloudfrontUrl,
    edge: props.edge,
    bucketName: props.bucketName,
    forceDestroy: props.forceDestroy,
    invalidation: props.invalidation,
    tags: props.tags,
  };

  const site = yield* makeKvSite(id, siteProps, {
    serverHost,
    image: { route: "/_next/image", host: imageHost },
    // Effect routes reach the server BEFORE the asset-manifest lookup;
    // manifest misses keep forwarding to the same server for SSR.
    ...(routes !== undefined ? { serverRoutes: [...routes] } : undefined),
  });

  // Seed the ISR/fetch cache: `.open-next/cache/<buildId>/...` uploaded
  // under `_cache/` (matching CACHE_BUCKET_KEY_PREFIX). Old builds' seeds
  // are left in place so a rolling deploy never breaks in-flight ISR.
  const cacheFiles = yield* AssetDeployment("CacheFiles", {
    bucket: cacheBucket,
    sourcePath: fromDist("cache") as unknown as string,
    prefix: NEXTJS_CACHE_PREFIX,
    purge: false,
  });

  return {
    ...site,
    build,
    cacheBucket,
    cacheFiles,
    imageFunction,
    imageUrl: imageFunction.functionUrl,
    revalidationFunction,
    revalidationQueue,
    server,
    serverUrl: server.functionUrl,
    tagCacheTable,
  };
});
