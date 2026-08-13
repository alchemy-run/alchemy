import type { ConfigError } from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Named, Tag } from "../../Named.ts";
import * as Namespace from "../../Namespace.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import { effectClass } from "../../Util/effect.ts";
import type {
  Function as LambdaFunctionResource,
  FunctionServices,
  FunctionTypeId,
} from "../Lambda/Function.ts";
import type { Providers } from "../Providers.ts";
import type { WebsiteShape } from "./Effectful.ts";
import {
  makeEffectFrameworkSite,
  makeFrameworkSite,
  type EffectFrameworkServerProps,
  type EffectFrameworkSiteAttributes,
  type FrameworkSiteAttributes,
  type FrameworkSiteConfig,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/**
 * An effectful `AWS.Website.Astro` was declared with `astro: { output:
 * "static" }`: a declared-static build prerenders every page and deploys
 * assets-only — no server function runs at request time, so the Effect
 * program's handlers could never execute. Raised as a defect at plan time.
 */
export class AstroEffectStaticOutputError extends Data.TaggedError(
  "AstroEffectStaticOutputError",
)<{
  message: string;
  websiteId: string;
}> {}

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro";

/** The AWS Lambda deploy target for the Astro build. */
export const ASTRO_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro/aws";

export interface AstroProps extends FrameworkSiteProps {
  /**
   * Serializable Astro config merged OVER the project's own
   * `astro.config.*` (which loads natively). `adapter` is owned by the AWS
   * deploy target and may not be set here.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand in the
     * Lambda; individual pages opt into prerendering with
     * `export const prerender = true`. `"static"` prerenders every page at
     * build time and deploys assets-only (no Lambda).
     * @default "server"
     */
    output?: "server" | "static";
    /** Source directory, relative to `rootDir`. @default "./src" */
    srcDir?: string;
    /** Public (static passthrough) directory. @default "./public" */
    publicDir?: string;
    /** Build output directory. @default "./dist" */
    outDir?: string;
    /** Trailing-slash handling for routes. */
    trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Serve the built error page (e.g. astro's `404.html`) for requests that
   * match no uploaded file. Only applies to `output: "static"` sites — a
   * server-backed site forwards misses to the Lambda instead.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404. Only applies
   * to `output: "static"` sites.
   */
  spa?: boolean;
}

/**
 * Props for the effectful `Astro` arms — today's props plus the required
 * `main` module anchor and the widened `server` options.
 */
export interface EffectAstroProps extends AstroProps {
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
 * Deploy an [Astro](https://astro.build) application to AWS: the server
 * bundle on a streaming Lambda Function URL, static assets (prerendered
 * pages included) in S3, and a CloudFront distribution whose edge router
 * serves uploaded files from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/aws` deploy target (a wrangler-free
 * AWS Lambda adapter is injected — your `astro.config.*` must not declare
 * one) — the package must be installed in your project.
 *
 * Pages render on demand by default (`output: "server"`); pages that
 * `export const prerender = true` are prerendered at build time and served
 * from S3. With `astro: { output: "static" }` every page is prerendered
 * and the deploy is assets-only — no Lambda.
 *
 * @resource
 * @section Creating Astro Sites
 * @example Basic Astro App
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * @section Static Sites
 * @example Fully Static Astro Site
 * ```typescript
 * const site = yield* AWS.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   errorPage: "404.html",
 * });
 * ```
 *
 * @section Server Configuration
 * @example Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
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
 * API from the same site: the program threads into the server Lambda in
 * collect-only mode (bindings collect env vars and IAM at deploy time,
 * exactly like an effect Lambda) while the framework-built bundle ships
 * as-is, and the CloudFront edge router forwards `server.routes` (default
 * `["/api/*"]`) to the server BEFORE the static-asset manifest. The
 * program must live in a dedicated module whose default export is the
 * class, anchored by `main: import.meta.url`. Delivery is automatic: the
 * AWS deploy target pre-resolves Astro's `virtual:astro:fetchable` to a
 * generated wrapper that runs the effect `fetch` first for
 * `server.routes` and falls back to Astro's own pipeline — in the
 * production build and in `astro dev` alike. An existing `src/fetch.ts`
 * is composed as the fallback, or — if it already mounts the alchemy
 * bridge — wins outright (`server: { takeover: false }` forces that
 * explicit tier).
 *
 * @example Astro site with an effect-native API
 * ```typescript
 * // src/site.ts — narrow subpath imports keep the IaC engine out of the
 * // Astro server graph; never import the `alchemy/AWS` provider barrel
 * // from a site module.
 * import { GetItem, GetItemHttp, Table } from "alchemy/AWS/DynamoDB";
 * import { Astro } from "alchemy/AWS/Website";
 * import { passthrough } from "alchemy/serve";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Visits = Table("Visits", {
 *   partitionKey: "pk",
 *   attributes: { pk: "S" },
 * });
 *
 * export default class Site extends Astro<Site>()(
 *   "Site",
 *   {
 *     rootDir: ".",
 *     main: import.meta.url,
 *     server: { routes: ["/api/*"] },
 *   },
 *   Effect.gen(function* () {
 *     const getItem = yield* GetItem(yield* Visits);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://localhost");
 *         if (url.pathname === "/api/visits") {
 *           const result = yield* getItem({
 *             Key: { pk: { S: "current" } },
 *           }).pipe(Effect.orDie);
 *           return yield* HttpServerResponse.json(result.Item);
 *         }
 *         // Not ours — Astro endpoints and pages serve the rest.
 *         return yield* passthrough;
 *       }),
 *     };
 *   }).pipe(Effect.provide(GetItemHttp)),
 * ) {}
 * ```
 */
export const Astro: {
  <Self>(): {
    <
      const Id extends string,
      Shape extends WebsiteShape,
      InitReq extends
        | FunctionServices
        | PlatformServices
        | LambdaFunctionResource = never,
    >(
      id: Id,
      props: EffectAstroProps,
      impl: Effect.Effect<Shape, ConfigError, InitReq>,
    ): Effect.Effect<
      EffectFrameworkSiteAttributes,
      never,
      | Providers
      | Exclude<
          InitReq,
          FunctionServices | PlatformServices | LambdaFunctionResource
        >
    > &
      Named<Id> & {
        new (): MakeShape<Shape, WebsiteShape> &
          Named<Id> &
          Tag<FunctionTypeId>;
      };
    (
      id: string,
      props?: AstroProps,
    ): Effect.Effect<FrameworkSiteAttributes, never, Providers> & {
      new (): FrameworkSiteAttributes;
    };
  };
  <
    const Id extends string,
    Shape extends WebsiteShape,
    InitReq extends
      | FunctionServices
      | PlatformServices
      | LambdaFunctionResource = never,
  >(
    id: Id,
    props: EffectAstroProps,
    impl: Effect.Effect<Shape, ConfigError, InitReq>,
  ): Effect.Effect<
    EffectFrameworkSiteAttributes,
    never,
    | Providers
    | Exclude<
        InitReq,
        FunctionServices | PlatformServices | LambdaFunctionResource
      >
  > &
    Named<Id>;
  (
    id: string,
    props?: AstroProps,
  ): Effect.Effect<FrameworkSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        effectClass(makeAstro(id, props, impl))
    : makeAstro(id, props, impl)) as any;

const makeAstro = (
  id: string,
  props: AstroProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> => {
  // Server output is the documented default: astro's own zero-config
  // default is `"static"`. The inline config merges OVER the project's
  // `astro.config.*`, so an explicit file-level `output` is superseded;
  // opt into a fully prerendered site with `astro: { output: "static" }`.
  const output = props.astro?.output ?? "server";
  const config: FrameworkSiteConfig = {
    name: "Astro",
    framework: ASTRO_FRAMEWORK_SPECIFIER,
    target: ASTRO_AWS_TARGET_SPECIFIER,
    options: { astro: { ...props.astro, output } },
    static:
      output === "static"
        ? { spa: props.spa, errorPage: props.errorPage }
        : undefined,
  };
  if (impl === undefined) {
    return makeFrameworkSite(id, props, config).pipe(Namespace.push(id));
  }
  // Astro's effectful delivery is the fetchable wrapper (DESIGN §6.2c) —
  // cloud-agnostic, injected INSIDE the astro build rather than through a
  // generated Lambda entry: the AWS deploy target's integration
  // pre-resolves `virtual:astro:fetchable` to a wrapper mounting the AWS
  // serve shell, in the production `ssr` bundle and Astro's Node dev
  // server alike. `runtimeDelivery` stays "external" — the framework
  // artifact ships byte-for-byte and the deploy-time sentinel scan finds
  // the shell's sentinel bundled into `dist/server` (the wiring
  // handshake holds even for this auto-injected tier). `takeover: false`
  // stands the injection down (handled by the shared `effectOptions`
  // gate): the user mounts the bridge in their own fetch file
  // (`src/fetch.ts`) instead. The extra option rides the framework
  // `make()`'s `targetConfig` channel into the AWS deploy target's
  // config (`AstroAwsConfig.effect`).
  config.effectOptions = ({ mainPath, routes }) => ({
    targetConfig: { effect: { main: mainPath, routes: [...routes] } },
  });
  // A declared-static build deploys assets-only (no server function), so
  // an Effect program's handlers could never run — fail fast at plan.
  if (output === "static" && !globalThis.__ALCHEMY_RUNTIME__) {
    return Effect.die(
      new AstroEffectStaticOutputError({
        message:
          `AWS.Website.Astro("${id}", ...) combines an Effect program with ` +
          `\`astro: { output: "static" }\` — a declared-static build ` +
          `prerenders every page and deploys assets-only, so no server ` +
          `function would ever run the program's handlers. Remove the ` +
          `static output override (server output is the default) or drop ` +
          `the Effect program.`,
        websiteId: id,
      }),
    );
  }
  return makeEffectFrameworkSite(id, props as EffectAstroProps, config, impl);
};
