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

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The AWS Lambda deploy target for the Waku build. */
export const WAKU_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/waku/aws";

export interface WakuProps extends FrameworkSiteProps {
  /**
   * Waku config overrides (`srcDir`, `distDir`, `basePath`, `vite`, ...)
   * merged over the project's own `waku.config.ts`. `unstable_adapter` is
   * owned by the AWS deploy target and may not be set here.
   */
  waku?: Record<string, unknown>;
}

/**
 * Props for the effectful `Waku` arms — today's props plus the required
 * `main` module anchor and the widened `server` options.
 */
export interface EffectWakuProps extends WakuProps {
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
 * Deploy a [Waku](https://waku.gg) application to AWS: the RSC server on a
 * streaming Lambda Function URL, static assets (SSG pages included) in S3,
 * and a CloudFront distribution whose edge router serves uploaded files
 * from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/waku` with the
 * `@alchemy.run/frontend-frameworks/waku/aws` deploy target (this package's fork
 * of waku's aws-lambda adapter, streaming enabled) — both must be installed
 * in your project.
 *
 * @resource
 * @section Creating Waku Sites
 * @example Basic Waku App
 * ```typescript
 * const site = yield* AWS.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Waku("Web", {
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
 * const site = yield* AWS.Website.Waku("Web", {
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
 * collect-only mode (bindings collect env vars and IAM at deploy time)
 * while the waku-built bundle ships as-is, and the CloudFront edge router
 * forwards `server.routes` (default `["/api/*"]`) to the server BEFORE the
 * static-asset manifest. The program must live in a dedicated module whose
 * default export is the class (`main: import.meta.url`) and be mounted in
 * the server entry via `alchemy/serve`.
 *
 * @example Waku site with an effect-native API
 * ```typescript
 * // src/site.ts — narrow subpath imports keep the IaC engine out of the
 * // Waku server graph; never import the `alchemy/AWS` provider barrel
 * // from a site module.
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { Waku } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends Waku<Site>()(
 *   "Site",
 *   { main: import.meta.url, server: { routes: ["/api/*"] } },
 *   Effect.gen(function* () {
 *     const getObject = yield* GetObject(yield* Data);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* getObject({ Key: "hello.txt" }).pipe(
 *           Effect.orDie,
 *         );
 *         return HttpServerResponse.text(String(object.Body));
 *       }),
 *     };
 *   }).pipe(Effect.provide(GetObjectHttp)),
 * ) {}
 * ```
 */
export const Waku: {
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
      props: EffectWakuProps,
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
      props?: WakuProps,
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
    props: EffectWakuProps,
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
    props?: WakuProps,
  ): Effect.Effect<FrameworkSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        effectClass(makeWaku(id, props, impl))
    : makeWaku(id, props, impl)) as any;

const wakuConfig = (props: WakuProps): FrameworkSiteConfig => ({
  name: "Waku",
  framework: WAKU_FRAMEWORK_SPECIFIER,
  target: WAKU_AWS_TARGET_SPECIFIER,
  options: props.waku ? { waku: props.waku } : undefined,
});

const makeWaku = (
  id: string,
  props: WakuProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  impl === undefined
    ? makeFrameworkSite(id, props, wakuConfig(props)).pipe(Namespace.push(id))
    : makeEffectFrameworkSite(
        id,
        props as EffectWakuProps,
        wakuConfig(props),
        impl,
      );
