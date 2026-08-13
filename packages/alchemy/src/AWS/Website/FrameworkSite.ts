import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { initialCwd } from "../../Util/Node.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { asEffect } from "../../Util/types.ts";
import type { Distribution } from "../CloudFront/Distribution.ts";
import type { Invalidation } from "../CloudFront/Invalidation.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  Function as LambdaFunction,
  type FunctionProps,
} from "../Lambda/Function.ts";
import { CurrentRegion } from "../Region.ts";
import type { Bucket } from "../S3/Bucket.ts";
import type { AssetDeployment } from "./AssetDeployment.ts";
import {
  compileServerRoutes,
  DEFAULT_SERVER_ROUTES,
  deploySiblingHandlers,
  RPC_CLAIM,
  validateImplAnchor,
  type WebsiteServerOptions,
} from "./Effectful.ts";
import { Server, type ServerDevProps } from "./Server.ts";
import { makeKvSite, type StaticSiteProps } from "./StaticSite.ts";
import type {
  WebsiteAssetsConfig,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

/**
 * SSR server (Lambda) configuration shared by the framework website
 * composites.
 */
export interface FrameworkServerProps {
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
}

/**
 * Props shared by every framework website composite (SvelteKit, Nuxt,
 * Waku, Octane, Astro). Each composite extends this with its
 * framework-specific configuration field.
 */
export interface FrameworkSiteProps {
  /**
   * Project root directory (the directory containing `package.json`).
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
  server?: FrameworkServerProps;
  /**
   * Static asset upload configuration.
   */
  assets?: WebsiteAssetsConfig;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
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
 * Server options for an *effectful* framework composite (an Effect program
 * as the third argument): the Lambda tuning the plain composites already
 * accept plus the effectful routing/delivery knobs (`routes`, `verify`,
 * `takeover`).
 */
export interface EffectFrameworkServerProps
  extends FrameworkServerProps, WebsiteServerOptions {}

/**
 * Props for a framework composite's effectful arms — today's props plus the
 * required `main` module anchor and the widened `server` options.
 */
export interface EffectFrameworkSiteProps extends FrameworkSiteProps {
  /**
   * The module URL default-exporting this class (`main: import.meta.url`)
   * — identical to `AWS.Lambda.Function`'s Effect form. Required with an
   * impl: the framework-built server bundle re-imports the program by path
   * (via the `alchemy/serve` mount or the generated wrapper entry).
   */
  main: string;
  /**
   * Server routing + delivery + Lambda tuning. `server.routes` (default
   * `["/api/*"]`) is the URL space the effect `fetch` owns — compiled into
   * the viewer-request CloudFront Function so matching requests reach the
   * server Lambda before the asset manifest.
   */
  server?: EffectFrameworkServerProps;
}

/**
 * The attributes a deployed framework composite resolves to. In dev mode
 * (`alchemy dev`) the cloud-resource attributes are `undefined` and `url`
 * is the framework's own dev server address.
 */
export interface FrameworkSiteAttributes {
  /** S3 bucket holding the uploaded assets (`undefined` in dev). */
  bucket: Bucket | undefined;
  /** The framework build (`AWS.Website.Server`). */
  build: Server;
  /** The uploaded asset deployment (`undefined` in dev). */
  files: AssetDeployment | undefined;
  /** The standalone CloudFront distribution (`undefined` in dev and for Router-attached sites). */
  distribution: Distribution | undefined;
  /** The CloudFront invalidation issued for this deployment, if enabled. */
  invalidation: Invalidation | undefined;
  /** The site's namespace prefix in the CloudFront KeyValueStore. */
  kvNamespace: string | undefined;
  /** The SSR server Lambda (`undefined` in dev and for assets-only builds). */
  server: LambdaFunction | undefined;
  /** The server Lambda's Function URL. */
  serverUrl: Input<string | undefined> | undefined;
  /** The most significant URL the site serves at — always `urls[0]`. */
  url: Input<string | undefined>;
  /** Every URL that serves this site, most significant first. */
  urls: Input<string | undefined>[];
}

/**
 * Attributes of an effectful framework composite: the framework-site
 * attributes with the server Lambda always present — in dev it is the
 * locally-emulated effect Lambda (the sibling the non-fetch surface rides),
 * on deploy the collect-only framework server Lambda.
 */
export interface EffectFrameworkSiteAttributes extends FrameworkSiteAttributes {
  /** The effect-carrying server Lambda. */
  server: LambdaFunction;
  /** The server Lambda's Function URL. */
  serverUrl: Input<string | undefined>;
}

/**
 * The resolved context handed to a framework's wrapper-entry generator
 * ({@link FrameworkSiteConfig.wrapperEntry}).
 */
export interface ServerWrapperEntryContext {
  /** Absolute path of the user's effect module (`props.main`, URL-decoded). */
  mainPath: string;
  /** The route globs the effect `fetch` owns. */
  routes: readonly string[];
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** AWS deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: every page was prerendered at build time, so no
   * server function is created and misses resolve to the error page (or
   * the index page for SPAs). Set by composites whose framework supports
   * a fully static output (Astro's `output: "static"`).
   */
  static?: { spa?: boolean; errorPage?: string } | undefined;
  /**
   * Tier default for an Effect program's runtime delivery on this
   * framework: `"external"` (the explicit tier — the framework artifact
   * deploys byte-for-byte and the user mounts `alchemy/serve` in the
   * framework's server entry; the deploy-time sentinel scan enforces the
   * wiring) or `"wrapper"` (the auto-inject tier — the framework
   * integration generates the mounting entry). Every AWS framework
   * currently defaults to `"external"`; a framework flips to `"wrapper"`
   * by supplying {@link wrapperEntry}.
   * @default "external"
   */
  runtimeDelivery?: "external" | "wrapper";
  /**
   * Wrapper-entry code generator for the auto-inject tier: produce the
   * source of the generated server entry that mounts the effect program in
   * front of the framework handler (composed at the fetch layer, BEFORE
   * the single `awslambda.streamifyResponse` wrap). When present (and the
   * user did not opt out via `server: { takeover: false }`), the entry is
   * written to `<root>/.alchemy/generated/<id>/entry.mjs` before the
   * framework build child runs, its path rides the deploy target's
   * `config.main` seam (`options.main`), and the effect module's content
   * hash is folded into the build's memo surface so effect edits redeploy.
   */
  wrapperEntry?: (ctx: ServerWrapperEntryContext) => string;
  /**
   * Framework-integrated wrapper delivery — the auto-inject tier for
   * frameworks whose deploy target already *generates* the server entry
   * (SvelteKit's in-memory kit adapter): derive extra framework build
   * options from the impl anchor instead of writing a standalone wrapper
   * entry file. The returned object (JSON-serializable) merges into the
   * build `options` for BOTH the production build (the target's entry
   * generator composes the effect fetch ahead of the framework handler,
   * inside the one `streamifyResponse` wrap) and the dev server (the
   * framework mounts the effect dev middleware in front of its own dev
   * server). Flips `runtimeDelivery` to `"wrapper"` unless the user opts
   * out via `server: { takeover: false }`. Mutually exclusive with
   * {@link wrapperEntry} ({@link wrapperEntry} wins when both are set).
   */
  effectOptions?: (ctx: ServerWrapperEntryContext) => Record<string, unknown>;
}

/** A wrapper entry prepared by {@link prepareServerWrapperEntry}. */
export interface PreparedServerWrapperEntry {
  /**
   * Absolute path of the generated entry module
   * (`<root>/.alchemy/generated/<id>/entry.mjs`).
   */
  entryPath: string;
  /**
   * Content hash over the user's effect module and the generated entry —
   * folded into the framework build's `options` (which participate in the
   * `Server` memo hash) so effect-module edits trigger a rebuild even
   * though `.alchemy/` is outside the hashed input set.
   */
  effectHash: string;
}

/**
 * Write a framework's generated wrapper entry under
 * `<root>/.alchemy/generated/<id>/entry.mjs` — inside the project root so
 * the file is importable/bundlable by the framework toolchain — and derive
 * the effect-module content hash that keys rebuilds. Runs BEFORE the
 * `Server` build resource is declared, so the entry exists when the build
 * child starts.
 * @internal
 */
export const prepareServerWrapperEntry = Effect.fn(
  "AWS.Website.ServerWrapperEntry",
)(function* (options: {
  id: string;
  rootDir: string | undefined;
  /** The user's effect module (`props.main` — a path or `file:` URL). */
  main: string;
  routes: readonly string[];
  code: (ctx: ServerWrapperEntryContext) => string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(initialCwd, options.rootDir ?? ".");
  const mainPath = options.main.startsWith("file:")
    ? yield* path.fromFileUrl(new URL(options.main)).pipe(Effect.orDie)
    : path.resolve(initialCwd, options.main);
  const code = options.code({ mainPath, routes: options.routes });
  const entryDir = path.join(root, ".alchemy", "generated", options.id);
  const entryPath = path.join(entryDir, "entry.mjs");
  yield* fs.makeDirectory(entryDir, { recursive: true }).pipe(Effect.orDie);
  yield* fs.writeFileString(entryPath, code).pipe(Effect.orDie);
  const mainSource = yield* fs.readFileString(mainPath).pipe(Effect.orDie);
  const effectHash = yield* sha256Object({ entry: code, main: mainSource });
  return { entryPath, effectHash } satisfies PreparedServerWrapperEntry;
});

/**
 * Resolve the impl anchor for a framework-integrated wrapper
 * ({@link FrameworkSiteConfig.effectOptions}): derive the extra build
 * options from the anchor's absolute path, plus a content hash over the
 * effect module folded into the build options so effect-module edits
 * rebuild even when the module lives outside the hashed project tree.
 * @internal
 */
const prepareEffectBuildOptions = Effect.fn("AWS.Website.EffectBuildOptions")(
  function* (options: {
    /** The user's effect module (`props.main` — a path or `file:` URL). */
    main: string;
    routes: readonly string[];
    code: (ctx: ServerWrapperEntryContext) => Record<string, unknown>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mainPath = options.main.startsWith("file:")
      ? yield* path.fromFileUrl(new URL(options.main)).pipe(Effect.orDie)
      : path.resolve(initialCwd, options.main);
    const extra = options.code({ mainPath, routes: options.routes });
    const mainSource = yield* fs.readFileString(mainPath).pipe(Effect.orDie);
    const effectHash = yield* sha256Object({
      options: extra,
      main: mainSource,
    });
    return { extra, effectHash };
  },
);

/**
 * The shared implementation behind the framework website composites:
 * build the framework through its AWS deploy target, then deploy the
 * server output on a streaming Lambda Function URL with static assets in
 * S3 behind a CloudFront distribution (or attach to a shared Router).
 *
 * During `alchemy dev` the site is the framework's own dev server (native
 * HMR) and no cloud resources are declared; `Alchemy.remote()` opts back
 * into the full live deployment.
 *
 * Callers pipe `Namespace.push(id)` themselves (the composites do), so
 * resource FQNs are identical to the previous per-framework
 * implementations.
 */
export const makeFrameworkSite = Effect.fn("AWS.Website.FrameworkSite")(
  function* (
    id: string,
    props: FrameworkSiteProps,
    config: FrameworkSiteConfig,
  ) {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;

    const build = yield* Server("Build", {
      framework: config.framework,
      target: config.target,
      root: props.rootDir,
      env: props.server?.environment,
      options: config.options,
      memo: props.memo,
      dev: props.dev,
    });

    if (isLocal) {
      return {
        bucket: undefined,
        build,
        files: undefined,
        distribution: undefined,
        invalidation: undefined,
        kvNamespace: undefined,
        server: undefined,
        serverUrl: undefined,
        url: build.url,
        urls: [build.url],
      };
    }

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

    if (config.static) {
      const site = yield* makeKvSite(id, {
        ...siteProps,
        errorPage: config.static.errorPage,
        spa: config.static.spa,
      });
      return {
        ...site,
        build,
        server: undefined,
        serverUrl: undefined,
      };
    }

    const server = yield* LambdaFunction("Server", {
      main: build.serverEntry as unknown as string,
      handler: "handler",
      isExternal: true,
      // The AWS deploy target's finishing pass writes the server directory
      // as a complete Node deployment unit (entry + chunks) — ship it
      // as-is.
      bundle: false,
      runtime: props.server?.runtime ?? "nodejs24.x",
      architecture: props.server?.architecture,
      memorySize: props.server?.memorySize ?? 1024,
      timeout: props.server?.timeout ?? Duration.seconds(30),
      env: props.server?.environment,
      functionUrl: {
        authType: "NONE",
        invokeMode: "RESPONSE_STREAM",
      },
    });

    const serverHost = Output.map((url: string | undefined) => {
      if (!url) {
        throw new Error(
          `The ${config.name} server function did not produce a Function URL.`,
        );
      }
      return new URL(url).hostname;
    })(server.functionUrl as any) as Input<string>;

    const site = yield* makeKvSite(id, siteProps, { serverHost });

    return {
      ...site,
      build,
      server,
      serverUrl: server.functionUrl,
    };
  },
);

/**
 * Lambda props for the effect program when it deploys as its own
 * effect-native Function — the runtime re-evaluation world (the deployed
 * framework bundle re-imports the class) and the dev sibling (the impl
 * runs in the local Lambda emulator while the framework's own dev server
 * hosts the fetch mount). Ships the JSON round-trip `Duration` shape so
 * the dev dual's RPC-sidecar serialization (capnweb) never sees a class
 * instance (see `StaticSite.serverFunctionProps`).
 * @internal
 */
export const effectServerFunctionProps = (props: EffectFrameworkSiteProps) => ({
  main: props.main,
  // The Effect HTTP bridge is buffered — a BUFFERED public Function URL.
  functionUrl: { authType: "NONE" as const },
  memorySize: props.server?.memorySize ?? 1024,
  timeout: JSON.parse(
    JSON.stringify(props.server?.timeout ?? Duration.seconds(30)),
  ) as Duration.Duration,
  runtime: props.server?.runtime,
  architecture: props.server?.architecture,
  env: props.server?.environment as Record<string, any> | undefined,
});

/**
 * The shared implementation behind the framework composites' *effectful*
 * arms (an Effect program as the third argument):
 *
 * - **plan/deploy** — the program threads into the server Lambda in
 *   collect-only mode (impl + `bundle: false`): the impl's init runs at
 *   plan time in the engine (bindings collect env vars + IAM policy
 *   statements, intercepted `Config` reads pack into the Lambda env), the
 *   framework-built artifact ships byte-for-byte, and the resolved props
 *   are stamped with `runtimeDelivery` (the deploy-time sentinel scan
 *   enforces the `alchemy/serve` mount on the explicit tier).
 *   `server.routes` compiles into the site's CloudFront `serverRoutes`
 *   check so a static file can never shadow an API path.
 * - **dev** — the framework's own dev server runs in the sidecar with the
 *   collected env map lowered into its process environment (plus the
 *   alchemy stack markers, so the in-process `alchemy/serve` mount engages)
 *   while the effect program also deploys into the local Lambda emulator
 *   as the sibling function.
 * - **runtime** — the deployed bundle re-imports the class; delegate
 *   straight to the Lambda platform call, which owns the runtime
 *   re-evaluation contract.
 */
export const makeEffectFrameworkSite = (
  id: string,
  propsEff:
    | EffectFrameworkSiteProps
    | Effect.Effect<EffectFrameworkSiteProps, any, any>,
  config: FrameworkSiteConfig,
  impl: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  // Prop-effect ConfigError surfaces as a defect at plan time (matching the
  // typed overloads, whose result error channel is `never`).
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      const props = yield* asEffect(propsEff);
      return yield* (LambdaFunction as any)(
        id,
        effectServerFunctionProps(props),
        impl,
      ) as Effect.Effect<any, never, any>;
    }
    const props = yield* asEffect(propsEff);
    yield* validateImplAnchor(id, config.name, props.main);
    const routes = props.server?.routes ?? DEFAULT_SERVER_ROUTES;
    // Validate the route globs eagerly — a plan-time defect even in dev,
    // where the edge compile never runs.
    yield* compileServerRoutes(id, routes);
    // Impl-declared resources register at the CALLER's namespace —
    // CF-Worker / effectful-StaticSite parity (the migration contract:
    // moving an effect Worker's body into the Website class must not move
    // its resources' FQNs). The composite's internal `Namespace.push(id)`
    // is an implementation detail and must not leak into the user's
    // program, so the ambient namespace at the construct call site is
    // re-provided around the impl. (`CurrentNamespace` reads the service
    // with `serviceOption`, so re-providing an undefined root is exact.)
    const callerNamespace = yield* Namespace.CurrentNamespace;
    const anchoredImpl = Effect.provideService(
      impl,
      Namespace.Namespace,
      callerNamespace as Namespace.NamespaceNode,
    );
    return yield* makeEffectSite(id, props, config, anchoredImpl, routes).pipe(
      Namespace.push(id),
    );
  }) as Effect.Effect<any, never, any>;

const makeEffectSite = Effect.fn("AWS.Website.EffectFrameworkSite")(function* (
  id: string,
  props: EffectFrameworkSiteProps,
  config: FrameworkSiteConfig,
  impl: Effect.Effect<any, any, any>,
  routes: readonly string[],
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;

  // Framework-integrated wrapper delivery (config.effectOptions): the
  // framework's own deploy target generates the mounting entry from these
  // build options — in dev they additionally mount the framework's effect
  // dev middleware. `takeover: false` forces the explicit tier.
  // `wrapperEntry` (the standalone generated-entry seam) wins when both
  // are configured.
  const effectExtra =
    config.effectOptions !== undefined &&
    config.wrapperEntry === undefined &&
    props.server?.takeover !== false
      ? yield* prepareEffectBuildOptions({
          main: props.main,
          routes,
          code: config.effectOptions,
        })
      : undefined;

  if (isLocal) {
    // Dev: the effect program deploys into the local Lambda emulator (the
    // Function provider's dev dual) — evaluating the impl exactly as a
    // deploy would, so its resources register and its bindings/Config
    // reads collect into `Props.env`.
    const server = (yield* (LambdaFunction as any)(
      "Server",
      effectServerFunctionProps(props),
      impl,
    ) as Effect.Effect<any, never, any>) as LambdaFunction;
    const stack = yield* Stack;
    const stage = yield* Stage;
    // Dev/live env parity (DESIGN §9.2): the collected env map — packed
    // binding values and intercepted Config reads — is lowered into the
    // dev `Server` resource's env, which applies it to the framework dev
    // server's process environment. The stack markers make the in-process
    // `alchemy/serve` mount engage (its four-worlds guard declines
    // marker-less environments); the runtime phase is forced by the bridge
    // itself, so `ALCHEMY_PHASE` is deliberately NOT set here.
    // `AWS_REGION` mirrors the Lambda sandbox (which always provides it):
    // the serve shell's capability clients resolve `Region.fromEnv()`, so
    // the dev-server process needs the engine's resolved region — a shell
    // without `AWS_REGION` exported would otherwise die on the first
    // effect-served request. User `server.environment` cannot carry it
    // (a reserved Lambda env key would fail the live deploy).
    // `AWS_PROFILE` (when the engine authenticated through a profile)
    // points the shell's `Credentials.fromChain()` at the SAME AWS profile
    // the engine used — without it the chain resolves the developer's
    // *default* profile, which may be a different account than the one the
    // `remote()` resources were deployed into.
    const region = yield* CurrentRegion;
    const awsEnv = yield* AWSEnvironment.current;
    const build = yield* Server("Build", {
      framework: config.framework,
      target: config.target,
      root: props.rootDir,
      env: {
        AWS_REGION: region,
        ...(awsEnv.profile !== undefined
          ? { AWS_PROFILE: awsEnv.profile }
          : {}),
        ...props.server?.environment,
        ...((server as any).Props?.env ?? {}),
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stage,
      } as any,
      // Framework-integrated wrapper options ride into the dev build too:
      // the framework's `make()` mounts its effect dev middleware from
      // them, so `server.routes` dispatches to the effect fetch in front
      // of the framework's own dev server.
      options:
        effectExtra !== undefined
          ? { ...config.options, ...effectExtra.extra }
          : config.options,
      memo: props.memo,
      dev: props.dev,
    });
    const url = build.url as Input<string | undefined>;
    return {
      bucket: undefined,
      build,
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

  // Auto-inject tier: generate the wrapper entry BEFORE the build child
  // runs (unless the user forced the explicit tier via takeover: false).
  const wrapper =
    config.wrapperEntry !== undefined && props.server?.takeover !== false
      ? yield* prepareServerWrapperEntry({
          id,
          rootDir: props.rootDir,
          main: props.main,
          routes,
          code: config.wrapperEntry,
        })
      : undefined;
  const runtimeDelivery =
    wrapper !== undefined || effectExtra !== undefined
      ? ("wrapper" as const)
      : (config.runtimeDelivery ?? ("external" as const));

  const build = yield* Server("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: props.server?.environment,
    options:
      wrapper !== undefined
        ? {
            ...config.options,
            // The deploy target's user-entry seam (`config.main`) — the
            // generated wrapper becomes the framework's server entry.
            main: wrapper.entryPath,
            // Folds the effect module into the memo hash so effect edits
            // rebuild (the wrapper lives under `.alchemy/`, outside the
            // hashed input set).
            effectHash: wrapper.effectHash,
          }
        : effectExtra !== undefined
          ? {
              ...config.options,
              // Framework-integrated wrapper delivery: the deploy target's
              // own entry generator consumes these options (SvelteKit's
              // adapter composes `site.match(req) ?? respond(req)` inside
              // its generated Lambda entry).
              ...effectExtra.extra,
              // Folds the effect module into the memo hash so effect
              // edits rebuild even when the module lives outside the
              // hashed project tree.
              effectHash: effectExtra.effectHash,
            }
          : config.options,
    memo: props.memo,
    dev: props.dev,
  });

  // Sibling-function non-fetch delivery (DESIGN §2.1.3): the framework
  // artifact's entry is pre-streamified, so event-source handlers cannot
  // ride it. Deploy the same impl as a sibling effect Lambda FIRST (its
  // event sources register their mappings + IAM against the sibling; a
  // fetch-only impl retracts the sibling and deploys no extra Lambda),
  // then thread the redirect-wrapped impl into the site Lambda so its own
  // evaluation cannot re-target event sources at the framework artifact.
  const { siteImpl } = yield* deploySiblingHandlers({
    id,
    main: props.main,
    impl,
    runtime: props.server?.runtime,
    architecture: props.server?.architecture,
    memorySize: props.server?.memorySize,
    timeout: props.server?.timeout,
    env: props.server?.environment,
  });

  // The server Lambda in collect-only mode: the impl runs for binding
  // collection (env + IAM + VPC/EFS requests land through the ordinary
  // `attachBindings` machinery) while the framework-built artifact ships
  // as-is. `finalizeFunctionProps` stamps `runtimeDelivery`, validates the
  // routes, and rejects non-fetch listeners on external delivery; the
  // sentinel scan runs over the shipped directory at reconcile.
  const server = (yield* (LambdaFunction as any)(
    "Server",
    {
      main: build.serverEntry as unknown as string,
      handler: "handler",
      // The AWS deploy target's finishing pass writes the server directory
      // as a complete Node deployment unit (entry + chunks) — ship it
      // as-is.
      bundle: false,
      server: {
        routes: [...routes],
        verify: props.server?.verify,
        takeover: props.server?.takeover,
      },
      runtimeDelivery,
      runtime: props.server?.runtime ?? "nodejs24.x",
      architecture: props.server?.architecture,
      memorySize: props.server?.memorySize ?? 1024,
      timeout: props.server?.timeout ?? Duration.seconds(30),
      env: props.server?.environment,
      functionUrl: {
        authType: "NONE",
        invokeMode: "RESPONSE_STREAM",
      },
    },
    siteImpl,
  ) as Effect.Effect<any, never, any>) as LambdaFunction;

  const serverHost = Output.map((url: string | undefined) => {
    if (!url) {
      throw new Error(
        `The ${config.name} server function did not produce a Function URL.`,
      );
    }
    return new URL(url).hostname;
  })(server.functionUrl as any) as Input<string>;

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

  // `serverRoutes` (no `serverRoutesOnly`): the effect routes reach the
  // server BEFORE the asset-manifest lookup, while manifest misses keep
  // forwarding to the same server for framework SSR — unchanged from the
  // plain composites.
  const site = yield* makeKvSite(id, siteProps, {
    serverHost,
    // The universal rpc claim rides alongside the user's routes so
    // `POST /api/__rpc/<method>` always reaches the server Lambda.
    serverRoutes: [...routes, RPC_CLAIM],
  });

  return {
    ...site,
    build,
    server,
    serverUrl: server.functionUrl as Input<string | undefined>,
  };
});
