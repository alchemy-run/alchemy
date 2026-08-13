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

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/octane";

/** The AWS Lambda deploy target for the Octane build. */
export const OCTANE_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/octane/aws";

export interface OctaneProps extends FrameworkSiteProps {
  /**
   * Project root directory (the directory containing `vite.config.ts` and
   * `octane.config.ts`).
   * @default "."
   */
  rootDir?: string;
}

/**
 * Props for the effectful `Octane` arms — today's props plus the required
 * `main` module anchor and the widened `server` options.
 */
export interface EffectOctaneProps extends OctaneProps {
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
 * Deploy an [OctaneJS](https://octanejs.dev) application to AWS: Octane's
 * SSR server on a streaming Lambda Function URL, static assets in S3, and a
 * CloudFront distribution whose edge router serves uploaded files from S3
 * and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/octane` with the
 * `@alchemy.run/frontend-frameworks/octane/aws` deploy target — the project's
 * own `vite build` (with `@octanejs/vite-plugin`) produces the
 * self-contained node server bundle, and the target's finishing pass wraps
 * its fetch handler as a streaming Lambda handler. The project's
 * `octane.config.ts` must select the AWS marker adapter:
 *
 * ```ts
 * import { aws } from "@alchemy.run/frontend-frameworks/octane/aws-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: aws(),
 *   // ...
 * });
 * ```
 *
 * @resource
 * @section Creating Octane Sites
 * @example Basic Octane App
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
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
 * const site = yield* AWS.Website.Octane("Web", {
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
 * while the Octane-built bundle ships as-is, and the CloudFront edge
 * router forwards `server.routes` (default `["/api/*"]`) to the server
 * BEFORE the static-asset manifest. The program must live in a dedicated
 * module whose default export is the class (`main: import.meta.url`) and
 * be mounted in Octane's server entry via `alchemy/serve`.
 *
 * @example Octane site with an effect-native API
 * ```typescript
 * // src/site.ts — narrow subpath imports keep the IaC engine out of the
 * // Octane server graph; never import the `alchemy/AWS` provider barrel
 * // from a site module.
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { Octane } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends Octane<Site>()(
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
export const Octane: {
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
      props: EffectOctaneProps,
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
      props?: OctaneProps,
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
    props: EffectOctaneProps,
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
    props?: OctaneProps,
  ): Effect.Effect<FrameworkSiteAttributes, never, Providers>;
} = ((id?: any, props?: any, impl?: any) =>
  id === undefined
    ? (id: string, props: any, impl?: any) =>
        effectClass(makeOctane(id, props, impl))
    : makeOctane(id, props, impl)) as any;

const octaneConfig = (): FrameworkSiteConfig => ({
  name: "Octane",
  framework: OCTANE_FRAMEWORK_SPECIFIER,
  target: OCTANE_AWS_TARGET_SPECIFIER,
});

const makeOctane = (
  id: string,
  props: OctaneProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  impl === undefined
    ? makeFrameworkSite(id, props, octaneConfig()).pipe(Namespace.push(id))
    : makeEffectFrameworkSite(
        id,
        props as EffectOctaneProps,
        octaneConfig(),
        impl,
      );
