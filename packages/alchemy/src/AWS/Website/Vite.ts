import type { ConfigError } from "effect/Config";
import type * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import type { Named, Tag } from "../../Named.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import type {
  Function as LambdaFunction,
  FunctionServices,
  FunctionTypeId,
} from "../Lambda/Function.ts";
import type { Providers } from "../Providers.ts";
import type { WebsiteShape } from "./Effectful.ts";
import {
  StaticSite,
  type EffectStaticSiteAttributes,
  type EffectStaticSiteServerOptions,
  type StaticSiteAttributes,
  type StaticSiteProps,
} from "./StaticSite.ts";

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
}

/**
 * Props for the effectful `Vite` arms — {@link ViteProps} plus the
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
  const rootDir = props.rootDir ?? ".";
  const PATH = withLocalBins(rootDir);
  return {
    spa: true,
    ...props,
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
 * Deploy a [Vite](https://vite.dev) single-page app to AWS — the parity
 * twin of `Cloudflare.Website.Vite` for the SPA shape: the Vite build
 * uploads to a private S3 bucket behind CloudFront (SPA fallback on), and
 * an optional Effect program deploys as an effect-native server Lambda
 * that the edge router consults FIRST for `server.routes`, so a static
 * file can never shadow an API path.
 *
 * A thin convention layer over {@link StaticSite}: `rootDir` is the Vite
 * project, the build is `vite build` into `dist/`, dev runs `vite dev`
 * (both resolved against the project's own `node_modules/.bin`), and
 * `spa` defaults to `true` — override `build`, `dev`, or `spa` to
 * diverge. Everything else (domains, Router attachment, invalidation, the
 * effectful server) is `StaticSite` verbatim. Vite SSR on Lambda is not
 * covered by this construct yet.
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
 * @section Effectful Site
 * Pass an Effect program as the third argument to serve an effect-native
 * backend from the same deployment. The browser is untrusted — it talks
 * through a surface you define on `fetch` (an effect `HttpApi` schema is
 * the natural fit for a SPA), while the program's non-`fetch` methods stay
 * a trusted-caller RPC surface (in-process `createClient(Site)` from
 * server code, invoke-style bindings from sibling functions).
 *
 * @example Vite SPA with a schema'd backend
 * ```typescript
 * // src/backend.ts — see examples/aws-vite for the full HttpApi flagship
 * export default class Site extends Vite<Site>()(
 *   "Site",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const bucket = yield* Data;
 *     return {
 *       fetch: // HttpApiBuilder-served router over the shared schema
 *       visits: () => // trusted-caller method
 *     };
 *   }),
 * ) {}
 * ```
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
    props?: ViteProps,
  ): Effect.Effect<StaticSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        (StaticSite as any)()(id, viteDefaults(props ?? {}), impl)
    : (StaticSite as any)(id, viteDefaults(props ?? {}), impl)) as any;
