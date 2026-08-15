import type { ConfigError } from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import { toPath } from "../../FQN.ts";
import type { Input } from "../../Input.ts";
import type { Named, Tag } from "../../Named.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { isResource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { effectClass } from "../../Util/effect.ts";
import { asEffect } from "../../Util/types.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { CachePolicy } from "../CloudFront/CachePolicy.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { KeyValueStore } from "../CloudFront/KeyValueStore.ts";
import { KvEntries } from "../CloudFront/KvEntries.ts";
import { KvRoutesUpdate } from "../CloudFront/KvRoutesUpdate.ts";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_OPTIMIZED_POLICY_ID,
} from "../CloudFront/ManagedPolicies.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  Function as LambdaFunction,
  type FunctionArchitecture,
  type FunctionServices,
  type FunctionTypeId,
} from "../Lambda/Function.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import {
  buildHostRedirectInjection,
  CF_ROUTER_INJECTION,
  compactCloudFrontFunctionCode,
} from "./cfcode.ts";
import {
  attachLambdaServeShell,
  compileServerRoutes,
  DEFAULT_SERVER_ROUTES,
  validateImplAnchor,
  type CompiledServerRoutes,
  type WebsiteServerOptions,
  type WebsiteShape,
} from "./Effectful.ts";
import {
  normalizeWebsiteDomain,
  type StaticSiteBuildProps,
  type WebsiteAssetsConfig,
  type WebsiteDomainProps,
  type WebsiteEdgeProps,
  type WebsiteInvalidationProps,
  type WebsiteRouterDomainProps,
  type WebsiteStandaloneDomainProps,
} from "./shared.ts";

export interface StaticSiteProps {
  /**
   * Path to the local site directory.
   * @default "."
   */
  path?: Input<string>;
  /**
   * Optional build configuration executed before upload.
   */
  build?: StaticSiteBuildProps;
  /**
   * Environment variables exposed to the build command.
   */
  environment?: Record<string, Input<string>>;
  /**
   * Static site asset upload configuration.
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
   * (`https://dxxxx.cloudfront.net`). The default domain cannot be removed
   * from a distribution, so `false` is emulated at the edge: the generated
   * viewer-request CloudFront Function 301s requests that arrive on the
   * default domain to `https://<domain.name>` (path and query preserved),
   * and the default domain is excluded from the `urls` output.
   *
   * Requires `domain` when `false` (the site would be unreachable). Not
   * applicable to Router-attached sites (`domain.router`) — they own no
   * distribution.
   * @default true
   */
  cloudfrontUrl?: boolean;
  /**
   * Additional CloudFront Function customizations.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Index page served for the site root.
   * @default "index.html"
   */
  indexPage?: string;
  /**
   * Serve this site as a single-page application: any request that does not
   * match an uploaded file is answered with the `indexPage` and a `200`
   * status so client-side routing can take over.
   *
   * This is also the fallback behavior when neither `spa` nor `errorPage`
   * is set. Setting `spa: true` makes the intent explicit and guards
   * against accidentally combining it with `errorPage`.
   *
   * Mutually exclusive with `errorPage` (a static site returns a real
   * `404`; a SPA serves the app shell).
   * @default false
   */
  spa?: boolean;
  /**
   * Error page returned for 403/404 requests.
   * When set, CloudFront customErrorResponses are created and misses return
   * a real `404` status. Mutually exclusive with `spa`.
   */
  errorPage?: string;
  /**
   * Optional deterministic S3 bucket name for newly created buckets.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects before destroying created buckets.
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
  /**
   * Local dev configuration. When `alchemy dev` runs, the build/upload is
   * skipped and `command` is spawned as a long-lived child process tied to
   * the stack's scope. Alchemy does not proxy or interpret the process —
   * the dev server's own URL (e.g. `http://localhost:5173`) is what you
   * open in the browser.
   *
   * @example
   * ```typescript
   * AWS.Website.StaticSite("App", {
   *   path: "./app",
   *   build: { command: "npm run build", output: "dist" },
   *   dev: { command: "npm run dev" },
   * });
   * ```
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to
     * {@link StaticSiteProps.path} (the site directory), or
     * `process.cwd()` if neither is set.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}, merged on top of
     * `process.env`. `Redacted` values stay out of logs and state, so put
     * secrets here rather than interpolating them into {@link command}.
     */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /**
     * Override for the `url` output if alchemy fails to detect it from the
     * stdout of the dev command.
     */
    url?: string;
  };
}

/**
 * Server options for an *effectful* `StaticSite` (an Effect program as the
 * third argument): the routes the effect `fetch` owns plus tuning for the
 * server Lambda the program deploys as.
 */
export interface EffectStaticSiteServerOptions extends WebsiteServerOptions {
  /**
   * Extra environment variables for the server Lambda (binding-collected
   * env vars and intercepted `Config` values are added automatically).
   */
  environment?: Record<string, Input<string>>;
  /**
   * Memory for the server Lambda, in MB.
   * @default 1024
   */
  memorySize?: number;
  /**
   * Timeout for the server Lambda.
   * @default 30 seconds
   */
  timeout?: Duration.Duration;
  /**
   * Node.js runtime for the server Lambda.
   */
  runtime?: "nodejs22.x" | "nodejs24.x";
  /**
   * Instruction set architecture for the server Lambda.
   * @default "x86_64"
   */
  architecture?: FunctionArchitecture;
}

/**
 * Props for the effectful `StaticSite` arms — today's props plus the
 * required `main` module anchor and the `server` options.
 */
export interface EffectStaticSiteProps extends StaticSiteProps {
  /**
   * The module URL default-exporting this class (`main: import.meta.url`)
   * — identical to `AWS.Lambda.Function`'s Effect form. Required with an
   * impl: the deployed bundle re-imports the program by path.
   */
  main: string;
  /**
   * Server routing + Lambda tuning. `server.routes` (default `["/api/*"]`)
   * is the URL space the effect `fetch` owns — compiled into the
   * viewer-request CloudFront Function so matching requests reach the
   * server Lambda before the asset manifest, even under `spa: true`.
   */
  server?: EffectStaticSiteServerOptions;
}

/**
 * The attributes a deployed `StaticSite` resolves to. In dev mode
 * (`alchemy dev` with a `dev.command`) every cloud-resource attribute is
 * `undefined` and `url` is the external dev server's address.
 */
export interface StaticSiteAttributes {
  /** S3 bucket holding the uploaded assets (`undefined` in dev). */
  bucket: Bucket | undefined;
  /** The `build.command` run, when configured (`undefined` in dev). */
  build: Command.Build | undefined;
  /** The uploaded asset deployment (`undefined` in dev). */
  files: AssetDeployment | undefined;
  /** The standalone CloudFront distribution (`undefined` in dev and for Router-attached sites). */
  distribution: Distribution | undefined;
  /** The CloudFront invalidation issued for this deployment, if enabled. */
  invalidation: Invalidation | undefined;
  /** The site's namespace prefix in the CloudFront KeyValueStore. */
  kvNamespace: string | undefined;
  /** The most significant URL the site serves at — always `urls[0]`. */
  url: Input<string | undefined>;
  /** Every URL that serves this site, most significant first. */
  urls: Input<string | undefined>[];
}

/**
 * Attributes of an effectful `StaticSite`: the static-site attributes plus
 * the effect-native server Lambda.
 */
export interface EffectStaticSiteAttributes extends StaticSiteAttributes {
  /** The effect-native `AWS.Lambda.Function` serving `server.routes`. */
  server: LambdaFunction;
  /** The server Lambda's Function URL. */
  serverUrl: Input<string | undefined>;
}

/**
 * Deploy a static website to S3 and CloudFront using KV-based edge routing.
 *
 * `StaticSite` uploads site files to a private S3 bucket, creates a CloudFront
 * KeyValueStore with a file manifest for edge routing, and optionally builds
 * the site first. Supports standalone distribution or composition with
 * `AWS.Website.Router`.
 * @resource
 * @section Basic Sites
 * @example Simple Static Site
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./site",
 * });
 * ```
 *
 * @section Built Sites
 * @example Build A Vite App
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./frontend",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *   },
 *   environment: {
 *     VITE_API_URL: api.url,
 *   },
 * });
 * ```
 *
 * @section Single-Page Applications
 * @example SPA With Client-Side Routing
 * ```typescript
 * // Misses fall back to index.html with a 200 so the client router
 * // can handle the path.
 * const site = yield* StaticSite("App", {
 *   path: "./app",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *   },
 *   spa: true,
 * });
 * ```
 *
 * @section Custom Domains
 * @example Site With A Route 53 Domain
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./site",
 *   domain: {
 *     name: "www.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 *   errorPage: "404.html",
 * });
 * ```
 *
 * @section Router Composition
 * @example Serve Through A Router
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   domain: {
 *     router,
 *     path: "/docs",
 *   },
 * });
 * ```
 *
 * @example Host-Matched Router Attachment
 * ```typescript
 * // The site serves for docs.example.com on the router. On a same-stack
 * // router that owns a domain, this declaration alone provisions the
 * // hostname end-to-end: the site binds it onto the router's distribution
 * // (alias), certificate (SAN), and Route 53 record set. Wildcard
 * // patterns and cross-stack router refs register KV host-matching only —
 * // those hostnames must be covered by the router's own domain.
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   domain: {
 *     name: "docs.example.com",
 *     router,
 *   },
 * });
 * ```
 *
 * @section Effectful Site
 * Pass an Effect program as the third argument to serve an effect-native
 * API from the same site: the program deploys as an `AWS.Lambda.Function`
 * (bindings collect env vars and IAM at deploy time, exactly like an
 * effect Lambda), and the generated CloudFront edge router forwards
 * `server.routes` (default `["/api/*"]`) to it BEFORE the static-asset
 * manifest — an uploaded file can never shadow an API path, and the API
 * stays reachable under `spa: true`. The program must live in a dedicated
 * module whose default export is the class, anchored by
 * `main: import.meta.url`.
 *
 * The impl's non-`fetch` methods are **RPC methods** — the typed method
 * surface for trusted callers (in-process dispatch via the value-form
 * `createClient(Backend)` from `alchemy/Client`, and AWS invoke-style
 * bindings). The static frontend is untrusted: it talks to the backend
 * through the `fetch` handler — mount a schema-validated surface (effect
 * `HttpApi` / `@effect/rpc`) on it under `server.routes`.
 *
 * The program is a full effect Lambda, so its non-`fetch` surface — an
 * SQS consumer registered with `SQS.consumeQueueMessages`, and other
 * event sources — attaches directly to the site's own function (no
 * sibling function, unlike the framework composites). Event delivery
 * engages on deploy — `alchemy dev` does not dispatch queue events
 * locally.
 *
 * @example Static site with an effect-native API
 * ```typescript
 * // src/backend.ts — narrow subpath imports keep the IaC engine out of any
 * // graph that re-imports this module; never import the `alchemy/AWS`
 * // provider barrel from a site module.
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { StaticSite } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends StaticSite<Site>()(
 *   "Site",
 *   {
 *     path: "./dist",
 *     spa: true,
 *     main: import.meta.url,
 *   },
 *   Effect.gen(function* () {
 *     const getObject = yield* GetObject(yield* Data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* getObject({ Key: "hello.txt" });
 *         return HttpServerResponse.text(String(object.Body));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(GetObjectHttp)),
 * ) {}
 * ```
 */
export const StaticSite: {
  <Self>(): {
    <
      const Id extends string,
      Shape extends WebsiteShape,
      InitReq extends FunctionServices | PlatformServices | LambdaFunction =
        never,
    >(
      id: Id,
      props: EffectStaticSiteProps,
      impl: Effect.Effect<Shape, ConfigError, InitReq>,
    ): Effect.Effect<
      EffectStaticSiteAttributes,
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
      props: StaticSiteProps,
    ): Effect.Effect<StaticSiteAttributes, never, Providers> & {
      new (): StaticSiteAttributes;
    };
  };
  <
    const Id extends string,
    Shape extends WebsiteShape,
    InitReq extends FunctionServices | PlatformServices | LambdaFunction =
      never,
  >(
    id: Id,
    props: EffectStaticSiteProps,
    impl: Effect.Effect<Shape, ConfigError, InitReq>,
  ): Effect.Effect<
    EffectStaticSiteAttributes,
    never,
    | Providers
    | Exclude<InitReq, FunctionServices | PlatformServices | LambdaFunction>
  > &
    Named<Id>;
  (
    id: string,
    props: StaticSiteProps,
  ): Effect.Effect<StaticSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        attachLambdaServeShell(effectClass(makeStaticSite(id, props, impl)))
    : makeStaticSite(id, props, impl)) as any;

const makeStaticSite = (
  id: string,
  propsEff: any,
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  impl === undefined
    ? makePlainStaticSite(id, propsEff)
    : makeEffectStaticSite(id, propsEff, impl);

const makePlainStaticSite = (
  id: string,
  props: StaticSiteProps,
): Effect.Effect<any, never, any> =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    // Mirrors the Cloudflare Website composites: during `alchemy dev` with
    // a `dev.command`, the site is the external dev server (spawned in the
    // dev sidecar so it survives user-code HMR) and no cloud resources are
    // declared; `Alchemy.remote()` opts back into the full live deployment.
    const isLocal = ctx.dev && remoted !== true;

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd:
          props.dev.cwd ??
          (typeof props.path === "string" ? props.path : undefined),
        env: props.dev.env,
      });
      const devUrl = Output.map(dev.url, (url) => url ?? props.dev?.url);
      return {
        bucket: undefined,
        build: undefined,
        files: undefined,
        distribution: undefined,
        invalidation: undefined,
        kvNamespace: undefined,
        url: devUrl,
        urls: [devUrl],
      };
    }

    return yield* makeKvSite(id, props);
  }).pipe(Namespace.push(id));

/**
 * Lambda props for the effectful arm's server Function — the effect
 * program deploys through the ordinary `FunctionBundle` machinery (virtual
 * entry, binding collection, packed Config env); this is the one AWS
 * Website case where the Effect program IS the server.
 */
const serverFunctionProps = (props: EffectStaticSiteProps) => ({
  main: props.main,
  // The Effect HTTP bridge is buffered — a BUFFERED public Function URL,
  // not the framework composites' RESPONSE_STREAM.
  functionUrl: { authType: "NONE" as const },
  memorySize: props.server?.memorySize ?? 1024,
  // Ship the JSON round-trip shape (`{_id:"Duration",...}`) instead of the
  // live `Duration` instance: `toTimeoutSeconds` explicitly supports it,
  // and the dev dual's RPC-sidecar serialization (capnweb) rejects class
  // instances like Duration.
  timeout: JSON.parse(
    JSON.stringify(props.server?.timeout ?? Duration.seconds(30)),
  ) as Duration.Duration,
  runtime: props.server?.runtime,
  architecture: props.server?.architecture,
  env: props.server?.environment as Record<string, any> | undefined,
});

const makeEffectStaticSite = (
  id: string,
  propsEff:
    | EffectStaticSiteProps
    | Effect.Effect<EffectStaticSiteProps, any, any>,
  impl: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  // Prop-effect ConfigError surfaces as a defect at plan time (matching the
  // typed overloads, whose result error channel is `never`).
  Effect.gen(function* () {
    // Runtime world: the deployed bundle's virtual entry imports this
    // module's default export and re-evaluates the program inside the
    // Lambda. `AlchemyContext` and the CDN sub-resources are plan-only
    // machinery whose services don't exist there — delegate straight to
    // the Lambda platform call, which owns the runtime re-evaluation
    // contract (stub Stack, runtime ConfigProvider).
    if (globalThis.__ALCHEMY_RUNTIME__) {
      const props = yield* asEffect(propsEff);
      return yield* (LambdaFunction as any)(
        id,
        serverFunctionProps(props),
        impl,
      ) as Effect.Effect<any, never, any>;
    }
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const props = yield* asEffect(propsEff);
    yield* validateImplAnchor(id, "StaticSite", props.main);
    const routes = props.server?.routes ?? DEFAULT_SERVER_ROUTES;
    // Validate the route globs eagerly — a plan-time defect even in dev,
    // where the edge compile never runs.
    yield* compileServerRoutes(id, routes);

    // The effect program IS the server: an effect-native Lambda Function
    // at the caller's namespace under the site's own id — mirroring
    // Cloudflare, where the Worker IS the site — so resources the impl's
    // init declares resolve exactly as on a plain `AWS.Lambda.Function`.
    const server = (yield* (LambdaFunction as any)(
      id,
      serverFunctionProps(props),
      impl,
    ) as Effect.Effect<any, never, any>) as LambdaFunction;

    // Dev: the effect Lambda runs in the local emulator (the Function
    // provider's dev dual); the frontend is the external `dev.command`
    // server. No CDN resources are declared; `Alchemy.remote()` opts back
    // into the full live deployment.
    const isLocal = ctx.dev && remoted !== true;
    if (isLocal) {
      const dev = props.dev
        ? yield* Command.Dev("Dev", {
            command: props.dev.command,
            cwd:
              props.dev.cwd ??
              (typeof props.path === "string" ? props.path : undefined),
            env: props.dev.env,
          }).pipe(Namespace.push(id))
        : undefined;
      const devUrl = dev
        ? Output.map(dev.url, (url) => url ?? props.dev?.url)
        : undefined;
      const url = (devUrl ?? server.functionUrl) as Input<string | undefined>;
      return {
        bucket: undefined,
        build: undefined,
        files: undefined,
        distribution: undefined,
        invalidation: undefined,
        kvNamespace: undefined,
        server,
        serverUrl: server.functionUrl as Input<string | undefined>,
        url,
        urls: [url],
      };
    }

    const serverHost = Output.map((url: string | undefined) => {
      if (!url) {
        throw new Error(
          `AWS.Website.StaticSite("${id}"): the server function did not produce a Function URL.`,
        );
      }
      return new URL(url).hostname;
    })(server.functionUrl as any) as Input<string>;

    const site = yield* makeKvSite(id, props, {
      serverHost,
      serverRoutes: [...routes],
      serverRoutesOnly: true,
    }).pipe(Namespace.push(id));

    return {
      ...site,
      server,
      serverUrl: server.functionUrl as Input<string | undefined>,
    };
  }) as Effect.Effect<any, never, any>;

/**
 * Dynamic server origin for {@link makeKvSite} — the KV metadata gains a
 * `servers` entry so requests that match no uploaded file are forwarded to
 * the server instead of a static fallback.
 * @internal
 */
export interface KvSiteServerOptions {
  /**
   * Hostname of the dynamic server origin (e.g. a Lambda Function URL
   * host). Requests that miss the file manifest are forwarded here with
   * `x-forwarded-host` set.
   */
  serverHost: Input<string>;
  /**
   * Optional dedicated image-optimization origin: requests whose path
   * starts with `route` (e.g. `/_next/image`) are forwarded to `host`
   * instead of the server origin (see `metadata.image` in cfcode.ts).
   */
  image?: {
    route: string;
    host: Input<string>;
  };
  /**
   * Route globs the server owns — matched at the edge BEFORE the asset
   * manifest lookup (see the `serverRoutes` check in `routeSite`,
   * cfcode.ts), so a static file can never shadow a server path. Uses the
   * `runWorkerFirst` glob dialect (`*` matches any run including `/`;
   * leading `!` marks an exclusion).
   */
  serverRoutes?: string[];
  /**
   * The server serves ONLY {@link serverRoutes}: manifest misses outside
   * them use the static fallback rules (`spa` / index page) instead of
   * being forwarded to the server, and the distribution's default origin
   * stays the S3 bucket. This is the effectful-`StaticSite` shape — a
   * fullstack framework site (SSR misses) leaves this unset.
   */
  serverRoutesOnly?: boolean;
}

/**
 * Shared implementation behind `StaticSite` and the SSR framework
 * composites (`AWS.Website.Nuxt`, ...): S3 + CloudFront + KV-manifest edge
 * routing, optionally with a dynamic server origin for misses.
 * @internal
 */
export const makeKvSite = Effect.fn("AWS.Website.KvSite")(function* (
  id: string,
  props: StaticSiteProps,
  server?: KvSiteServerOptions,
) {
  const domain = normalizeWebsiteDomain(props.domain);
  const routerDomain = domain?.router
    ? (domain as WebsiteRouterDomainProps)
    : undefined;
  const standaloneDomain =
    domain && !domain.router
      ? (domain as WebsiteStandaloneDomainProps)
      : undefined;
  const sitePath = (props.path ?? ".") as string;
  const indexPage = props.indexPage ?? "index.html";
  const assetPrefix = normalizePrefix(props.assets?.path);
  const assetRoutes = [...(props.assets?.routes ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeRoutePath);
  const invalidationProps =
    props.invalidation !== undefined
      ? props.invalidation
      : { paths: "all" as const, wait: false };

  if (routerDomain && props.edge) {
    return yield* Effect.die(
      `Cannot provide both "edge" and "domain.router". Use the "edge" prop on the Router component.`,
    );
  }
  if (routerDomain && props.cloudfrontUrl !== undefined) {
    return yield* Effect.die(
      `"cloudfrontUrl" does not apply to a Router-attached site ("domain.router" is set): the site owns no distribution. Set "cloudfrontUrl" on the Router instead.`,
    );
  }
  if (props.cloudfrontUrl === false && !standaloneDomain) {
    return yield* Effect.die(
      `"cloudfrontUrl: false" requires a "domain" — without one the site would be unreachable (the CloudFront default domain is its only URL).`,
    );
  }
  if (routerDomain?.aliases?.length && !routerDomain.name) {
    return yield* Effect.die(
      `"domain.aliases" requires "domain.name" on a Router-attached site.`,
    );
  }
  if (
    routerDomain?.redirects?.length &&
    (!routerDomain.name || routerDomain.name.includes("*"))
  ) {
    return yield* Effect.die(
      `"domain.redirects" requires a concrete (non-wildcard) "domain.name" to redirect to.`,
    );
  }
  if (
    standaloneDomain?.redirects?.length &&
    standaloneDomain.name.includes("*")
  ) {
    return yield* Effect.die(
      `"domain.redirects" requires a concrete (non-wildcard) "domain.name" to redirect to.`,
    );
  }
  if (props.spa && props.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }
  if (server && props.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "errorPage" and a server origin: "errorPage" uses CloudFront custom error responses, which rewrite every 403/404 the distribution returns — including the server's own API responses. Use "spa" (with scoped server routes) or serve error pages from the app.`,
    );
  }
  if (server && props.spa && !server.serverRoutesOnly) {
    return yield* Effect.die(
      `A site whose server origin answers manifest misses routes them to the server; "spa" does not apply. Scope the server to explicit routes (an effectful site's "server.routes") to combine it with "spa".`,
    );
  }
  const compiledServerRoutes = server?.serverRoutes?.length
    ? yield* compileServerRoutes(id, server.serverRoutes)
    : undefined;
  if (server?.serverRoutesOnly && !compiledServerRoutes) {
    return yield* Effect.die(
      `"serverRoutesOnly" requires "serverRoutes" — without routes the server would be unreachable.`,
    );
  }

  const build = props.build
    ? yield* Command.Build("Build", {
        command: props.build.command,
        cwd: sitePath,
        memo: {
          include: props.build.include,
          exclude: props.build.exclude,
          lockfile: props.build.lockfile,
        },
        outdir: props.build.output,
        env: props.environment,
      })
    : undefined;

  const uploadSourcePath = (build?.outdir ?? sitePath) as string;

  const providedBucket = props.assets?.bucket;
  const bucket =
    providedBucket ??
    (yield* Bucket("Bucket", {
      bucketName: props.bucketName,
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    }));

  const routerPathPrefix = routerDomain?.path
    ? "/" + routerDomain.path.replace(/^\//, "").replace(/\/$/, "")
    : undefined;

  const files = yield* AssetDeployment("Files", {
    bucket: bucket,
    sourcePath: uploadSourcePath,
    prefix: normalizeUploadPrefix(assetPrefix, routerPathPrefix),
    purge: props.assets?.purge ?? true,
    fileOptions: props.assets?.fileOptions,
    textEncoding: props.assets?.textEncoding,
  });

  const stack = yield* Stack;
  const stage = yield* Stage;
  const ns = yield* Namespace.CurrentNamespace;
  const fqn = ns ? toPath(ns).join("/") : id;
  const kvNamespace = createHash("md5")
    .update(`${stack.name}-${stage}-${fqn}`)
    .digest("hex")
    .substring(0, 4);

  // Standalone distributions carry the asset prefix as the default
  // origin's `originPath` (so error-page fetches that bypass the edge
  // function still resolve); router-attached sites prefix at the edge via
  // the KV metadata instead.
  const s3MetadataDir = routerDomain && assetPrefix ? "/" + assetPrefix : "";

  const kvEntries = buildKvEntries({
    files,
    bucketDomain: bucket.bucketRegionalDomainName as Input<string>,
    s3Dir: s3MetadataDir,
    assetRoutes,
    indexPage,
    errorPage: props.errorPage,
    routerPathPrefix,
    redirect:
      routerDomain?.redirects?.length && routerDomain.name
        ? { hosts: routerDomain.redirects, to: routerDomain.name }
        : undefined,
    serverHost: server?.serverHost,
    imageRoute: server?.image?.route,
    imageHost: server?.image?.host,
    serverRoutes: compiledServerRoutes,
    serverRoutesOnly: server?.serverRoutesOnly === true,
  });

  let distributionId: Input<string>;
  let kvStoreArn: Input<string>;
  let distribution: Distribution | undefined;
  let urls: Input<string>[];

  if (routerDomain) {
    const routerRef = routerDomain.router;
    kvStoreArn = routerRef.kvStoreArn;
    distributionId = routerRef.distributionId;
    // One KV route entry per host pattern: the canonical name (or the
    // match-any-host "" pattern), each alias, and each redirect hostname
    // (so redirected requests still match this site's route — the edge
    // function then 301s them from the site's KV metadata).
    const hostPatterns: [id: string, pattern: string | undefined][] = [
      ["RoutesUpdate", routerDomain.name],
      ...(routerDomain.aliases ?? []).map((alias, index): [string, string] => [
        `RoutesUpdateAlias${index + 1}`,
        alias,
      ]),
      ...(routerDomain.redirects ?? []).map(
        (redirect, index): [string, string] => [
          `RoutesUpdateRedirect${index + 1}`,
          redirect,
        ],
      ),
    ];
    yield* Effect.forEach(
      hostPatterns,
      ([routeId, pattern]) =>
        KvRoutesUpdate(routeId, {
          store: kvStoreArn,
          namespace: routerRef.kvNamespace as any,
          key: "routes",
          entry: [
            "site",
            kvNamespace,
            pattern ? toHostPatternRegex(pattern) : "",
            routerPathPrefix ?? "/",
          ].join(","),
        }),
      { concurrency: "unbounded" },
    );
    // Site→Router hostname binding: this site's concrete hostnames are
    // bound onto the Router's distribution (alias), managed certificate
    // (SAN — a change replaces the certificate create-first), and Route 53
    // record set, so the declaration here alone fully provisions the
    // hostname. Wildcard patterns bind nothing concrete, and cross-stack
    // Router refs carry no `bindTargets` (bindings are same-stack) — in
    // both cases the site registers KV host-matching only and the
    // hostname must be covered by the Router's own `domain`.
    const concreteHostnames = [
      ...(routerDomain.name && !routerDomain.name.includes("*")
        ? [routerDomain.name]
        : []),
      ...(routerDomain.aliases ?? []).filter((alias) => !alias.includes("*")),
      ...(routerDomain.redirects ?? []),
    ];
    const bindTargets = routerRef.bindTargets;
    if (bindTargets && concreteHostnames.length > 0) {
      if (bindTargets.distribution && isResource(bindTargets.distribution)) {
        yield* bindTargets.distribution.bind`AWS.Website.Site(${fqn})`({
          aliases: concreteHostnames,
        });
      }
      if (bindTargets.certificate && isResource(bindTargets.certificate)) {
        yield* bindTargets.certificate.bind`AWS.Website.Site(${fqn})`({
          subjectAlternativeNames: concreteHostnames,
        });
      }
      if (bindTargets.records && isResource(bindTargets.records)) {
        yield* bindTargets.records.bind`AWS.Website.Site(${fqn})`({
          names: concreteHostnames,
        });
      }
    }
    // Host-matched attachment: the site's own hostnames (the router's
    // CloudFront URL never serves it — KV host-match). Path-only
    // attachment: derived from the router's primary URL, inheriting the
    // router's precedence (including its `cloudfrontUrl` choice).
    urls = routerDomain.name
      ? [
          `https://${routerDomain.name}${routerPathPrefix ?? ""}`,
          ...(routerDomain.aliases ?? []).map(
            (alias) => `https://${alias}${routerPathPrefix ?? ""}`,
          ),
        ]
      : [Output.interpolate`${routerRef.url}${routerPathPrefix ?? ""}`];
  } else {
    const domain = standaloneDomain;
    if (
      domain &&
      !domain.cert &&
      !domain.hostedZoneId &&
      domain.dns === false
    ) {
      return yield* Effect.die(
        "StaticSite domain configuration with `dns: false` requires `cert`.",
      );
    }

    const certificate =
      !domain || domain.cert
        ? domain?.cert
          ? { certificateArn: domain.cert }
          : undefined
        : yield* Certificate("Certificate", {
            domainName: domain.name,
            subjectAlternativeNames: [
              ...(domain.aliases ?? []),
              ...(domain.redirects ?? []),
            ],
            hostedZoneId: domain.hostedZoneId,
            tags: props.tags,
          });

    const kvStore = yield* KeyValueStore("KvStore", {});
    kvStoreArn = kvStore.keyValueStoreArn;

    const viewerRequest = yield* CloudFrontFunction("ViewerRequest", {
      comment: `${id} viewer request`,
      code: buildRequestFunctionCode({
        kvNamespace,
        userInjection: props.edge?.viewerRequest?.injection,
        hostRedirect: domain
          ? {
              to: domain.name,
              hosts: domain.redirects ?? [],
              cloudfrontDefault: props.cloudfrontUrl === false,
            }
          : undefined,
      }),
      keyValueStoreArns: [kvStore.keyValueStoreArn],
    });

    const viewerResponse = props.edge?.viewerResponse
      ? yield* CloudFrontFunction("ViewerResponse", {
          comment: `${id} viewer response`,
          code: buildResponseFunctionCode(props.edge.viewerResponse.injection),
          keyValueStoreArns: props.edge.viewerResponse.keyValueStoreArn
            ? [props.edge.viewerResponse.keyValueStoreArn]
            : undefined,
        })
      : undefined;

    const functionAssociations = [
      {
        eventType: "viewer-request" as const,
        functionArn: viewerRequest.functionArn,
      },
      ...(viewerResponse
        ? [
            {
              eventType: "viewer-response" as const,
              functionArn: viewerResponse.functionArn,
            },
          ]
        : []),
    ];

    const errorPage = "/" + (props.errorPage ?? indexPage).replace(/^\//, "");
    const customErrorResponses =
      props.errorPage && !server
        ? [
            {
              ErrorCode: 403,
              ResponseCode: "404",
              ResponsePagePath: errorPage,
              ErrorCachingMinTTL: 0,
            },
            {
              ErrorCode: 404,
              ResponseCode: "404",
              ResponsePagePath: errorPage,
              ErrorCachingMinTTL: 0,
            },
          ]
        : undefined;

    // Server-backed sites share one behavior between S3 assets and the
    // dynamic origin, so the cache policy must not cache responses that
    // carry no Cache-Control (SSR pages) while still honoring the
    // immutable Cache-Control the asset uploader sets. Managed
    // CachingOptimized would cache header-less SSR responses for a day.
    const serverCachePolicy = server
      ? yield* CachePolicy("ServerCachePolicy", {
          comment: `${id} server cache policy`,
          minTTL: 0,
          defaultTTL: 0,
          maxTTL: "365 days",
          parametersInCacheKeyAndForwardedToOrigin: {
            EnableAcceptEncodingGzip: true,
            EnableAcceptEncodingBrotli: true,
            QueryStringsConfig: { QueryStringBehavior: "all" },
            HeadersConfig: { HeaderBehavior: "none" },
            CookiesConfig: { CookieBehavior: "none" },
          },
        })
      : undefined;

    // The default origin is real (not a placeholder): static sites point
    // at the bucket through an OAC so requests that bypass the edge
    // function's origin switch — CloudFront's custom-error-page fetches
    // in particular — still resolve; server-backed sites point at the
    // server so misses stream from it even if the function is bypassed.
    // A `serverRoutesOnly` server (the effectful StaticSite) is
    // static-first: the default origin stays the bucket and only the edge
    // function's `serverRoutes` match switches to the server.
    const staticDefaultOrigin = !server || server.serverRoutesOnly === true;
    const oac = staticDefaultOrigin
      ? yield* OriginAccessControl("OriginAccessControl", {
          originType: "s3",
          description: `${id} origin access control`,
        })
      : undefined;

    distribution = yield* Distribution("Distribution", {
      aliases: domain
        ? [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])]
        : undefined,
      origins: [
        !staticDefaultOrigin
          ? {
              id: "default",
              domainName: server!.serverHost,
              customOriginConfig: {
                httpPort: 80,
                httpsPort: 443,
                originProtocolPolicy: "https-only" as const,
                originReadTimeout: "20 seconds",
                originSslProtocols: ["TLSv1.2"],
              },
            }
          : {
              id: "default",
              domainName: bucket.bucketRegionalDomainName,
              s3Origin: true,
              originAccessControlId: oac!.originAccessControlId,
              originPath: assetPrefix ? "/" + assetPrefix : undefined,
            },
      ],
      defaultCacheBehavior: {
        targetOriginId: "default",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: [
          "DELETE",
          "GET",
          "HEAD",
          "OPTIONS",
          "PATCH",
          "POST",
          "PUT",
        ],
        cachedMethods: ["GET", "HEAD"],
        compress: true,
        cachePolicyId: serverCachePolicy
          ? serverCachePolicy.cachePolicyId
          : MANAGED_CACHING_OPTIMIZED_POLICY_ID,
        originRequestPolicyId: server
          ? MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID
          : undefined,
        functionAssociations,
      },
      customErrorResponses,
      viewerCertificate: certificate
        ? {
            acmCertificateArn: certificate.certificateArn,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          }
        : undefined,
      tags: props.tags,
    });

    const dist = distribution;
    distributionId = dist.distributionId;

    if (domain?.hostedZoneId && domain.dns !== false) {
      yield* Effect.forEach(
        [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])],
        (name, index) =>
          Route53Record(`AliasRecord${index + 1}`, {
            hostedZoneId: domain.hostedZoneId!,
            name,
            type: "A",
            aliasTarget: {
              hostedZoneId: dist.hostedZoneId,
              dnsName: dist.domainName,
            },
          }),
        { concurrency: "unbounded" },
      );
    }

    // Precedence: the canonical domain, then aliases in declaration
    // order, then the CloudFront default domain (only while
    // `cloudfrontUrl` is enabled). Redirect hostnames never appear.
    urls = domain
      ? [
          Output.interpolate`https://${domain.name}`,
          ...(domain.aliases ?? []).map((alias) => `https://${alias}`),
          ...(props.cloudfrontUrl !== false
            ? [Output.interpolate`https://${dist.domainName}`]
            : []),
        ]
      : [Output.interpolate`https://${dist.domainName}`];
  }

  // The edge router signs S3 origin requests with OAC (sigv4, see
  // `setS3Origin` in cfcode.ts), so the bucket must allow the serving
  // distribution — without this policy every request 403s.
  const servingDistributionArn = routerDomain
    ? routerDomain.router.distributionArn
    : distribution!.distributionArn;
  const bucketPolicy: PolicyStatement = {
    Effect: "Allow",
    Principal: {
      Service: "cloudfront.amazonaws.com",
    },
    Action: ["s3:GetObject"],
    Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
    Condition: {
      StringEquals: {
        "AWS:SourceArn": servingDistributionArn as any,
      },
    },
  };
  yield* bucket.bind`AWS.S3.Policy(CloudFront, ${bucket})`({
    policyStatements: [bucketPolicy],
  });

  yield* KvEntries("KvEntries", {
    store: kvStoreArn,
    namespace: kvNamespace,
    entries: kvEntries,
    purge: props.assets?.purge ?? true,
  });

  const invalidation =
    invalidationProps === false
      ? undefined
      : yield* Invalidation("Invalidation", {
          distributionId: distributionId,
          version: files.version,
          wait: invalidationProps?.wait,
          paths:
            invalidationProps?.paths === "all" || !invalidationProps?.paths
              ? ["/*"]
              : invalidationProps.paths === "versioned"
                ? [`/${indexPage.replace(/^\/+/, "")}`]
                : invalidationProps.paths,
        });

  return {
    bucket: bucket,
    build,
    files,
    distribution,
    invalidation,
    kvNamespace,
    /**
     * The most significant URL the site serves at — always `urls[0]`.
     */
    url: urls[0],
    /**
     * Every URL that serves this site, most significant first —
     * `[https://<domain.name>?, ...aliases, <CloudFront default domain>?]`
     * (the default domain only while `cloudfrontUrl` is enabled).
     * Router-attached sites list their own hostnames (host-matched) or
     * the router's URL plus `domain.path` (path-only). Redirect
     * hostnames never appear — they serve no content.
     */
    urls,
  };
});

/**
 * Derive the CloudFront KV routing entries from the *uploaded* file list
 * (the `AssetDeployment`'s `files` attribute) so the manifest always
 * reflects exactly what landed in S3 — including build outputs that do not
 * exist at plan time.
 */
const buildKvEntries = (args: {
  files: { files: Output.Output<string[]> };
  bucketDomain: Input<string>;
  s3Dir: string;
  assetRoutes: string[];
  indexPage: string;
  errorPage: string | undefined;
  routerPathPrefix: string | undefined;
  redirect: { hosts: string[]; to: string } | undefined;
  serverHost: Input<string> | undefined;
  imageRoute: string | undefined;
  imageHost: Input<string> | undefined;
  serverRoutes: CompiledServerRoutes | undefined;
  serverRoutesOnly: boolean;
}): Input<Record<string, string>> =>
  Output.map(
    ([fileList, bucketDomain, serverHost, imageHost]: [
      string[] | undefined,
      string,
      string | undefined,
      string | undefined,
    ]) => {
      const entries: Record<string, string> = {};
      for (const file of fileList ?? []) {
        entries[`/${file}`] = "s3";
      }
      const errorPagePath =
        "/" + (args.errorPage ?? args.indexPage).replace(/^\//, "");
      const metadata: KvSiteMetadata = {
        base:
          args.routerPathPrefix && args.routerPathPrefix !== "/"
            ? args.routerPathPrefix
            : undefined,
        // A `serverRoutesOnly` server owns only its routes — misses keep
        // the static fallback (SPA/index rewrite) instead of the server.
        custom404:
          (serverHost !== undefined && !args.serverRoutesOnly) || args.errorPage
            ? undefined
            : errorPagePath,
        errorResponseCode:
          serverHost === undefined && args.errorPage ? 404 : undefined,
        s3: {
          domain: bucketDomain,
          dir: args.s3Dir,
          routes: args.assetRoutes,
        },
        servers: serverHost !== undefined ? [[serverHost]] : undefined,
        image:
          args.imageRoute !== undefined && imageHost !== undefined
            ? { route: args.imageRoute, host: imageHost }
            : undefined,
        redirect: args.redirect,
        serverRoutes: serverHost !== undefined ? args.serverRoutes : undefined,
        serverRoutesOnly:
          serverHost !== undefined && args.serverRoutesOnly ? true : undefined,
      };
      entries["metadata"] = JSON.stringify(metadata);
      return entries;
    },
  )(
    Output.all(
      args.files.files,
      Output.asOutput(args.bucketDomain as any),
      Output.asOutput(args.serverHost as any),
      Output.asOutput(args.imageHost as any),
    ) as Output.Output<
      [string[] | undefined, string, string | undefined, string | undefined]
    >,
  );

interface KvSiteMetadata {
  base?: string | undefined;
  custom404?: string | undefined;
  errorResponseCode?: number | undefined;
  s3: {
    domain: string;
    dir: string;
    routes: string[];
  };
  /**
   * Server origin hosts (`[[host, lat?, lon?], ...]`) the edge router
   * forwards misses to — see `findNearestServer` in cfcode.ts.
   */
  servers?: Array<Array<string>> | undefined;
  /**
   * Dedicated image-optimization origin: requests whose path starts with
   * `route` are forwarded to `host` — see `metadata.image` in cfcode.ts.
   */
  image?: { route: string; host: string } | undefined;
  /**
   * Router-attached redirect hostnames: matched requests whose `Host` is
   * in `hosts` are 301'd to `https://<to>` (path + query preserved) — see
   * the `metadata.redirect` check in `routeSite` in cfcode.ts.
   */
  redirect?: { hosts: string[]; to: string } | undefined;
  /**
   * Compiled `server.routes` (anchored regex sources): matched requests
   * switch to the server origin BEFORE the manifest lookup — see the
   * `serverRoutes` check in `routeSite` in cfcode.ts.
   */
  serverRoutes?: CompiledServerRoutes | undefined;
  /**
   * The server serves only {@link serverRoutes}: manifest misses use the
   * static fallback rules and never forward to the server.
   */
  serverRoutesOnly?: true | undefined;
}

const buildRequestFunctionCode = ({
  kvNamespace,
  userInjection,
  hostRedirect,
}: {
  kvNamespace: string;
  userInjection?: string;
  hostRedirect?: {
    to: string;
    hosts: string[];
    cloudfrontDefault: boolean;
  };
}) =>
  compactCloudFrontFunctionCode(`import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  ${
    hostRedirect
      ? buildHostRedirectInjection({
          to: hostRedirect.to,
          hosts: hostRedirect.hosts,
          cloudfrontDefault: hostRedirect.cloudfrontDefault,
        })
      : ""
  }
  ${CF_ROUTER_INJECTION}

  const kvNamespace = "${kvNamespace}";

  let metadata;
  try {
    const v = await cf.kvs().get(kvNamespace + ":metadata");
    metadata = JSON.parse(v);
  } catch (e) {}

  const response = await routeSite(kvNamespace, metadata);
  return response || event.request;
}`);

const buildResponseFunctionCode = (userInjection?: string) =>
  compactCloudFrontFunctionCode(`import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  return event.response;
}`);

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const normalizeUploadPrefix = (
  assetPrefix: string,
  routerPathPrefix: string | undefined,
) => {
  const parts = [assetPrefix, routerPathPrefix?.replace(/^\//, "")].filter(
    Boolean,
  );
  return parts.join("/") || "";
};

const normalizeRoutePath = (value: string) =>
  `/${value.replace(/^\/+|\/+$/g, "")}`;

/**
 * Convert a host pattern (`docs.example.com`, `*.example.com`) into the
 * escaped regex fragment stored in the Router's KV route table (matched by
 * the router's edge function).
 */
const toHostPatternRegex = (pattern: string) =>
  pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
