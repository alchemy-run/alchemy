import type { ConfigError } from "effect/Config";
import type * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import type { Named, Tag } from "../../Named.ts";
import * as Namespace from "../../Namespace.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import { effectClass } from "../../Util/effect.ts";
import type {
  Function as LambdaFunction,
  FunctionServices,
  FunctionTypeId,
} from "../Lambda/Function.ts";
import type { Providers } from "../Providers.ts";
import { attachLambdaServeBridge, type WebsiteShape } from "./Effectful.ts";
import {
  makeEffectFrameworkSite,
  makeFrameworkSite,
  type EffectFrameworkServerProps,
  type EffectFrameworkSiteAttributes,
  type FrameworkSiteAttributes,
  type FrameworkSiteConfig,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";
import {
  StaticSite,
  type EffectStaticSiteAttributes,
  type EffectStaticSiteServerOptions,
  type StaticSiteAttributes,
  type StaticSiteProps,
} from "./StaticSite.ts";

/** The framework-integration package that drives the Vite SSR build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The AWS Lambda deploy target for the Vite SSR build. */
export const VITE_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/aws";

/**
 * Props for `AWS.Website.Vite` — {@link StaticSiteProps} with the Vite
 * conventions applied for you: `path` becomes {@link ViteProps.rootDir},
 * and `build`/`dev`/`spa` default to the standard Vite project shape
 * (override any of them to diverge).
 */
export interface ViteProps extends Omit<StaticSiteProps, "path"> {
  /**
   * Vite project root (the directory containing `vite.config.ts` and
   * `index.html`). Relative paths resolve from the process working
   * directory.
   * @default "."
   */
  rootDir?: string;
  /**
   * The SPA arm: the Vite build ships as static assets only. Set
   * `ssr: true` for the server-rendered arm.
   * @default false
   */
  ssr?: false;
}

/**
 * Props for the effectful SPA `Vite` arms — {@link ViteProps} plus the
 * required `main` module anchor and the widened `server` options.
 */
export interface EffectViteProps extends ViteProps {
  /**
   * The module URL default-exporting this class (`main: import.meta.url`).
   * Required with an impl: the deployed bundle re-imports the program by
   * path.
   */
  main: string;
  /**
   * Server routing + Lambda tuning (`server.routes` defaults to
   * `["/api/*"]`).
   */
  server?: EffectStaticSiteServerOptions;
}

/**
 * Props for the SSR arm of `AWS.Website.Vite` — the framework-site shape
 * (server Lambda + S3 + CloudFront) driven by the project's own
 * `vite.config.*` through the vite Environment API.
 */
export interface ViteSsrProps extends FrameworkSiteProps {
  /**
   * Deploy the Vite build as a server-rendered site: the server
   * environment's entry runs on a streaming Lambda Function URL while the
   * client environment uploads to S3 behind CloudFront. Requires a
   * vite-plugin framework (TanStack Start, SolidStart, ...) configuring an
   * SSR environment in `vite.config.*`.
   */
  ssr: true;
  /**
   * Names the vite environments that make up the server build, for
   * frameworks that build more than one (e.g. React Server Components).
   *
   * A single-environment SSR build needs no configuration. For a
   * multi-environment build, point `entry` at the environment that
   * produces the server entry chunk and list the remaining server-side
   * environments in `children` so their chunks ship alongside it. The
   * `client` environment is always treated as static assets.
   *
   * @default { entry: "ssr", children: [] }
   */
  viteEnvironments?: {
    entry?: string;
    children?: string[];
  };
}

/**
 * Props for the effectful SSR `Vite` arms — {@link ViteSsrProps} plus the
 * required `main` module anchor and the widened `server` options.
 */
export interface EffectViteSsrProps extends ViteSsrProps {
  /**
   * The module URL default-exporting this class (`main: import.meta.url`).
   * Required with an impl: the framework-built server bundle re-imports
   * the program by path.
   */
  main: string;
  /**
   * Server routing + delivery + Lambda tuning (`server.routes` defaults to
   * `["/api/*"]`).
   */
  server?: EffectFrameworkServerProps;
}

/**
 * PATH with the project's (and its ancestors') `node_modules/.bin`
 * prepended, so the default `vite` commands resolve the PROJECT's vite
 * regardless of package manager or workspace hoisting — `npx` walks
 * node's package tree and can land on an unrelated install. Nonexistent
 * PATH entries are inert, so no probing is needed.
 */
const withLocalBins = (rootDir: string): string => {
  const root = NodePath.resolve(rootDir);
  const bins = [
    root,
    ...Array.from({ length: 3 }, (_, i) =>
      NodePath.resolve(root, "../".repeat(i + 1)),
    ),
  ].map((dir) => NodePath.join(dir, "node_modules", ".bin"));
  return [...bins, process.env.PATH ?? ""].join(NodePath.delimiter);
};

/** @internal The Vite-convention defaults merged under the user's props. */
export const viteDefaults = (props: ViteProps | EffectViteProps) => {
  const { ssr: _ssr, rootDir: _rootDir, ...rest } = props;
  const rootDir = props.rootDir ?? ".";
  const PATH = withLocalBins(rootDir);
  return {
    spa: true,
    ...rest,
    path: rootDir,
    build: props.build ?? {
      command: "vite build",
      output: "dist",
      include: [
        "src/**",
        "public/**",
        "index.html",
        "package.json",
        "vite.config.*",
        "tsconfig.json",
      ],
    },
    ...(props.build === undefined
      ? { environment: { PATH, ...props.environment } }
      : {}),
    dev: props.dev ?? { command: "vite dev", env: { PATH } },
  };
};

/**
 * Deploy a [Vite](https://vite.dev) app to AWS, in either Vite shape:
 *
 * - **SPA** (the default): the `vite build` output uploads to S3 behind
 *   CloudFront with SPA fallback on.
 * - **SSR** (`ssr: true`): for vite-plugin frameworks (TanStack Start,
 *   SolidStart, ...) — the server entry runs on a streaming Lambda
 *   Function URL, client assets upload to S3 behind CloudFront. Requires
 *   `@alchemy.run/frontend-frameworks` in your project.
 *
 * The SPA arm is a thin convention layer over {@link StaticSite} — domains,
 * Router attachment, invalidation, and the effectful server all work the
 * same. Under `alchemy dev` the site is vite's own dev server.
 *
 * @resource
 * @product Website
 * @category Websites
 *
 * @section Deploying a Vite SPA
 * @example Basic Vite app
 * ```typescript
 * const site = yield* AWS.Website.Vite("Web");
 * ```
 *
 * @example Vite project in a subdirectory
 * ```typescript
 * const site = yield* AWS.Website.Vite("Web", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * @section Deploying a Vite SSR app
 * @example TanStack Start
 * ```typescript
 * // vite.config.ts: plugins: [tanstackStart(), viteReact()]
 * const site = yield* AWS.Website.Vite("Web", {
 *   ssr: true,
 * });
 * ```
 *
 * @example Multi-environment server build (RSC-style)
 * ```typescript
 * const site = yield* AWS.Website.Vite("Web", {
 *   ssr: true,
 *   viteEnvironments: { entry: "rsc", children: ["ssr"] },
 * });
 * ```
 *
 * @section Effectful Site
 * @example Add an Effect backend
 * ```typescript
 * // src/backend.ts
 * import { GetItem, GetItemHttp, Table } from "alchemy/AWS/DynamoDB";
 * import { Vite } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Visits = Table("Visits", {
 *   partitionKey: "pk",
 *   attributes: { pk: "S" },
 * });
 *
 * export default class Site extends Vite<Site>()(
 *   "Site",
 *   { ssr: true, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getItem = yield* GetItem(yield* Visits);
 *     return {
 *       visits: () =>
 *         getItem({ Key: { pk: { S: "count" } } }).pipe(
 *           Effect.map((result) => Number(result.Item?.count?.N ?? "0")),
 *         ),
 *     };
 *   }).pipe(Effect.provide(GetItemHttp)),
 * ) {}
 * ```
 * Pass an Effect program as the third argument — on the SSR arm it runs
 * inside the framework's server Lambda; on the SPA arm it deploys as its
 * own effect-native Lambda. Bindings collect env vars and IAM at deploy
 * time, and `main: import.meta.url` anchors the module so the server
 * bundle can re-import it. Use narrow subpath imports
 * (`alchemy/AWS/DynamoDB`) — never the `alchemy/AWS` barrel — from a site
 * module. See `examples/aws-vite` (SPA + `HttpApi`) and
 * `examples/aws-tanstack` for full projects.
 *
 * @section Server Routes
 * @example Claim paths for the effect fetch
 * ```typescript
 * export default class Site extends Vite<Site>()(
 *   "Site",
 *   {
 *     main: import.meta.url,
 *     server: { routes: ["/api/*", "!/api/pages"] },
 *   },
 *   Effect.gen(function* () {
 *     return { fetch: HttpServerResponse.text("hello") };
 *   }),
 * ) {}
 * ```
 * The effect `fetch` owns `server.routes` (default `["/api/*"]`): the
 * edge router consults it before the static-asset manifest, so a static
 * file can never shadow an API path — even under SPA fallback. Exclusion
 * globs (`"!/api/pages"`) hand a path back to the framework. The same
 * routing runs in front of vite's dev server during `alchemy dev`.
 *
 * @section Calling RPC Methods
 * @example From server code
 * ```typescript
 * // e.g. inside a TanStack Start server function
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * const backend = createClient(Backend);
 * const count = await backend.visits();
 * ```
 * Non-`fetch` methods are RPC methods for trusted server code — dispatch
 * is in-process, no HTTP hop. Browser code is untrusted: it reaches the
 * backend through `fetch` — mount a schema-validated surface (effect
 * `HttpApi` / `@effect/rpc`) under `server.routes`.
 *
 * @section Event Sources
 * @example Consume an SQS queue
 * ```typescript
 * export const Jobs = SQS.Queue("Jobs");
 *
 * // inside the Effect program:
 * yield* SQS.consumeQueueMessages(yield* Jobs, (records) =>
 *   records.pipe(Stream.runForEach((r) => Effect.log(r.body))),
 * );
 * ```
 * On the SSR arm event handlers deploy on a sibling Lambda
 * (`<SiteId>-Handlers`) built from the same module; on the SPA arm they
 * attach to the site's own Lambda. Delivery engages on deploy —
 * `alchemy dev` does not dispatch queue events locally.
 */
export const Vite: {
  <Self>(): {
    <
      const Id extends string,
      Shape extends WebsiteShape,
      InitReq extends FunctionServices | PlatformServices | LambdaFunction =
        never,
    >(
      id: Id,
      props: EffectViteSsrProps,
      impl: Effect.Effect<Shape, ConfigError, InitReq>,
    ): Effect.Effect<
      EffectFrameworkSiteAttributes,
      never,
      | Providers
      | Exclude<InitReq, FunctionServices | PlatformServices | LambdaFunction>
    > &
      Named<Id> & {
        new (): MakeShape<Shape, WebsiteShape> &
          Named<Id> &
          Tag<FunctionTypeId>;
      };
    <
      const Id extends string,
      Shape extends WebsiteShape,
      InitReq extends FunctionServices | PlatformServices | LambdaFunction =
        never,
    >(
      id: Id,
      props: EffectViteProps,
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
      props: ViteSsrProps,
    ): Effect.Effect<FrameworkSiteAttributes, never, Providers> & {
      new (): FrameworkSiteAttributes;
    };
    (
      id: string,
      props?: ViteProps,
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
    props: EffectViteSsrProps,
    impl: Effect.Effect<Shape, ConfigError, InitReq>,
  ): Effect.Effect<
    EffectFrameworkSiteAttributes,
    never,
    | Providers
    | Exclude<InitReq, FunctionServices | PlatformServices | LambdaFunction>
  > &
    Named<Id>;
  <
    const Id extends string,
    Shape extends WebsiteShape,
    InitReq extends FunctionServices | PlatformServices | LambdaFunction =
      never,
  >(
    id: Id,
    props: EffectViteProps,
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
    props: ViteSsrProps,
  ): Effect.Effect<FrameworkSiteAttributes, never, Providers>;
  (
    id: string,
    props?: ViteProps,
  ): Effect.Effect<StaticSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        attachLambdaServeBridge(effectClass(makeVite(id, props, impl)))
    : makeVite(id, props, impl)) as any;

const viteSsrConfig = (props: ViteSsrProps): FrameworkSiteConfig => ({
  name: "Vite",
  framework: VITE_FRAMEWORK_SPECIFIER,
  target: VITE_AWS_TARGET_SPECIFIER,
  options:
    props.viteEnvironments !== undefined
      ? { viteEnvironments: props.viteEnvironments }
      : undefined,
  // Auto-inject (wrapper) tier: the AWS deploy target's generated Lambda
  // entry composes the effect fetch ahead of the framework's server entry
  // (inside the one `streamifyResponse` wrap), and vite's dev server
  // mounts the effect dev middleware — both driven by this `effect` build
  // option. Only consulted on the impl arms; plain sites are untouched.
  effectOptions: ({ mainPath, routes }) => ({
    effect: { main: mainPath, routes: [...routes] },
  }),
});

const makeVite = (
  id: string,
  props: any = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> => {
  if (props?.ssr === true) {
    const config = viteSsrConfig(props as ViteSsrProps);
    return impl === undefined
      ? makeFrameworkSite(id, props as ViteSsrProps, config).pipe(
          Namespace.push(id),
        )
      : makeEffectFrameworkSite(id, props as EffectViteSsrProps, config, impl);
  }
  return (StaticSite as any)(id, viteDefaults(props ?? {}), impl);
};
