import type { ConfigError } from "effect/Config";
import type * as Effect from "effect/Effect";
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

/** The framework-integration package that drives the SvelteKit build. */
export const SVELTEKIT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit";

/** The AWS Lambda deploy target for the SvelteKit build. */
export const SVELTEKIT_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit/aws";

export interface SvelteKitProps extends FrameworkSiteProps {
  /**
   * SvelteKit configuration passed to the `sveltekit(config)` Vite plugin
   * (kit v3 takes its config in memory — a `svelte.config.js` on disk is an
   * upstream error). The `adapter` field is injected by the AWS deploy
   * target and may not be set here. Must be JSON-serializable (it persists
   * in state).
   */
  kit?: Record<string, unknown>;
}

/**
 * Props for the effectful `SvelteKit` arms — today's props plus the
 * required `main` module anchor and the widened `server` options.
 */
export interface EffectSvelteKitProps extends SvelteKitProps {
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
 * Deploy a SvelteKit application to AWS: kit's SSR server on a streaming
 * Lambda Function URL, static assets (prerendered pages included) in S3,
 * and a CloudFront distribution whose edge router serves uploaded files
 * from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/sveltekit` with the
 * `@alchemy.run/frontend-frameworks/sveltekit/aws` deploy target (an in-memory
 * kit adapter emitting a streaming Lambda handler) — both must be
 * installed in your project.
 *
 * @resource
 * @section Creating SvelteKit Sites
 * @example Basic SvelteKit App
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
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
 * const site = yield* AWS.Website.SvelteKit("Web", {
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
 * collect-only mode (bindings collect env vars and IAM at deploy time),
 * and the CloudFront edge router forwards `server.routes` (default
 * `["/api/*"]`) to the server BEFORE the static-asset manifest. The
 * program must live in a dedicated module whose default export is the
 * class (`main: import.meta.url`).
 *
 * Delivery is the auto-inject (wrapper) tier: the AWS deploy target's
 * generated Lambda entry routes by `server.routes` between the effect
 * fetch (authoritative inside the routes — an `HttpRouter` miss renders
 * as its own 404, never delegation; hand a path back to kit with an
 * exclusion glob like `routes: ["/api/*", "!/api/foo"]`) and kit's own
 * `respond` — inside the single streaming handler wrap, so streamed
 * effect responses ride the Function URL's `RESPONSE_STREAM` pipe — and
 * `alchemy dev` mounts the same dispatch as a middleware in front of
 * kit's Vite dev server (dev bindings hit the real cloud with your
 * ambient credentials). An explicit `alchemy/serve/sveltekit` mount in
 * `hooks.server.ts` makes the generated arm stand down, and
 * `server: { takeover: false }` forces the explicit tier outright.
 *
 * @example SvelteKit site with an effect-native API
 * ```typescript
 * // src/site.ts — narrow subpath imports keep the IaC engine out of the
 * // kit server graph; never import the `alchemy/AWS` provider barrel
 * // from a site module.
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { SvelteKit } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends SvelteKit<Site>()(
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
 *         // the effect owns /api/* — unknown paths get its own 404
 *         return yield* HttpServerResponse.json(
 *           { error: "not found" },
 *           { status: 404 },
 *         );
 *       }),
 *     };
 *   }).pipe(Effect.provide(GetObjectHttp)),
 * ) {}
 * ```
 */
export const SvelteKit: {
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
      props: EffectSvelteKitProps,
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
      props?: SvelteKitProps,
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
    props: EffectSvelteKitProps,
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
    props?: SvelteKitProps,
  ): Effect.Effect<FrameworkSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        effectClass(makeSvelteKit(id, props, impl))
    : makeSvelteKit(id, props, impl)) as any;

const svelteKitConfig = (props: SvelteKitProps): FrameworkSiteConfig => ({
  name: "SvelteKit",
  framework: SVELTEKIT_FRAMEWORK_SPECIFIER,
  target: SVELTEKIT_AWS_TARGET_SPECIFIER,
  options: props.kit ? { kit: props.kit } : undefined,
  // Auto-inject (wrapper) tier: the AWS deploy target's generated Lambda
  // entry composes the effect fetch ahead of kit's `respond` (inside the
  // one `streamifyResponse` wrap), and kit's dev server mounts the effect
  // dev middleware — both driven by this `effect` build option. Only
  // consulted on the impl arms; plain sites are untouched.
  effectOptions: ({ mainPath, routes }) => ({
    effect: { main: mainPath, routes: [...routes] },
  }),
});

const makeSvelteKit = (
  id: string,
  props: SvelteKitProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  impl === undefined
    ? makeFrameworkSite(id, props, svelteKitConfig(props)).pipe(
        Namespace.push(id),
      )
    : makeEffectFrameworkSite(
        id,
        props as EffectSvelteKitProps,
        svelteKitConfig(props),
        impl,
      );
