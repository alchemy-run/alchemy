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
import { attachLambdaServeShell, type WebsiteShape } from "./Effectful.ts";
import {
  makeEffectFrameworkSite,
  makeFrameworkSite,
  type EffectFrameworkServerProps,
  type EffectFrameworkSiteAttributes,
  type FrameworkSiteAttributes,
  type FrameworkSiteConfig,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Nuxt build. */
export const NUXT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nuxt";

/** The AWS Lambda deploy target for the Nuxt build. */
export const NUXT_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/nuxt/aws";

export interface NuxtProps extends FrameworkSiteProps {
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (highest-priority layer). `nitro.preset` is owned by the AWS deploy
   * target and may not be set here.
   */
  nuxt?: Record<string, unknown>;
}

/**
 * Props for the effectful `Nuxt` arms — today's props plus the required
 * `main` module anchor and the widened `server` options.
 */
export interface EffectNuxtProps extends NuxtProps {
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
 * Deploy a Nuxt application to AWS: the nitro server on a streaming Lambda
 * Function URL, static assets (prerendered pages included) in S3, and a
 * CloudFront distribution whose edge router serves uploaded files from S3
 * and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/nuxt` with the
 * `@alchemy.run/frontend-frameworks/nuxt/aws` deploy target (nitro's `aws-lambda` preset,
 * streaming enabled) — both must be installed in your project.
 *
 * @resource
 * @section Creating Nuxt Sites
 * @example Basic Nuxt App
 * ```typescript
 * const site = yield* AWS.Website.Nuxt("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Nuxt("Web", {
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
 * const site = yield* AWS.Website.Nuxt("Web", {
 *   rootDir: "./app",
 *   server: {
 *     memorySize: 2048,
 *     environment: {
 *       NUXT_PUBLIC_API_BASE: api.url,
 *     },
 *   },
 * });
 * ```
 *
 * @section Effectful Site
 * Pass an Effect program as the third argument to serve an effect-native
 * API from the same site: the program threads into the server Lambda in
 * collect-only mode (bindings collect env vars and IAM at deploy time)
 * while the nitro-built bundle ships as-is, and the CloudFront edge router
 * forwards `server.routes` (default `["/api/*"]`) to the server BEFORE the
 * static-asset manifest. The program must live in a dedicated module whose
 * default export is the class (`main: import.meta.url`) and be mounted in
 * the nitro server via `alchemy/serve/nitro` (a `server/middleware`
 * handler).
 *
 * @example Nuxt site with an effect-native API
 * ```typescript
 * // src/site.ts
 * export default class Site extends AWS.Website.Nuxt<Site>()(
 *   "Site",
 *   { main: import.meta.url, server: { routes: ["/api/*"] } },
 *   Effect.gen(function* () {
 *     const bucket = yield* AWS.S3.Bucket("Data");
 *     const getObject = yield* AWS.S3.GetObject(bucket);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* getObject({ Key: "hello.txt" }).pipe(
 *           Effect.orDie,
 *         );
 *         return HttpServerResponse.text(String(object.Body));
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.S3.GetObjectHttp)),
 * ) {}
 * ```
 */
export const Nuxt: {
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
      props: EffectNuxtProps,
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
      props?: NuxtProps,
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
    props: EffectNuxtProps,
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
    props?: NuxtProps,
  ): Effect.Effect<FrameworkSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        // The class carries the AWS serve shell so `Serve.make(Site)` (and
        // the `toEventHandler` nitro mount built on it) dispatches through
        // the Lambda/Node layer recipe instead of the Cloudflare bridge.
        attachLambdaServeShell(effectClass(makeNuxt(id, props, impl)))
    : makeNuxt(id, props, impl)) as any;

const nuxtConfig = (props: NuxtProps): FrameworkSiteConfig => ({
  name: "Nuxt",
  framework: NUXT_FRAMEWORK_SPECIFIER,
  target: NUXT_AWS_TARGET_SPECIFIER,
  options: props.nuxt ? { nuxt: props.nuxt } : undefined,
});

const makeNuxt = (
  id: string,
  props: NuxtProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  impl === undefined
    ? makeFrameworkSite(id, props, nuxtConfig(props)).pipe(Namespace.push(id))
    : makeEffectFrameworkSite(
        id,
        props as EffectNuxtProps,
        nuxtConfig(props),
        impl,
      );
