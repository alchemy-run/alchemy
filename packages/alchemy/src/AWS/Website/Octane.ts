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
import { lambdaServeBridge, type WebsiteShape } from "./Effectful.ts";
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
   * Server delivery + Lambda tuning (the edge routes `/api/*` to
   * `["/api/*"]`).
   */
  server?: EffectFrameworkServerProps;
}

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to AWS: Octane's
 * SSR server on a streaming Lambda Function URL, static assets in S3, and
 * CloudFront routing between them.
 *
 * Requires `@alchemy.run/frontend-frameworks` in your project, and the
 * project's `octane.config.ts` must select the AWS adapter:
 *
 * ```ts
 * import { aws } from "@alchemy.run/frontend-frameworks/octane/aws-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: aws(),
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
 * @example Add an Effect backend
 * ```typescript
 * // src/backend.ts
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { Octane } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends Octane<Site>()(
 *   "Site",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getObject = yield* GetObject(yield* Data);
 *     return {
 *       hello: () =>
 *         getObject({ Key: "hello.txt" }).pipe(
 *           Effect.map((object) => String(object.Body)),
 *         ),
 *     };
 *   }).pipe(Effect.provide(GetObjectHttp)),
 * ) {}
 * ```
 * Pass an Effect program as the third argument — it runs inside the
 * server Lambda, and its bindings collect env vars and IAM at deploy
 * time. `main: import.meta.url` anchors the module so the server bundle
 * can re-import it; mount the program in Octane's server entry via
 * `alchemy/Serve`. Use narrow subpath imports (`alchemy/AWS/S3`) — never
 * the `alchemy/AWS` barrel — from a site module.
 *
 * @section Server Routes
 * @example Claim paths for the effect fetch
 * ```typescript
 * export default class Site extends Octane<Site>()(
 *   "Site",
 *   {
 *     main: import.meta.url,
 *   },
 *   Effect.gen(function* () {
 *     return { fetch: HttpServerResponse.text("hello") };
 *   }),
 * ) {}
 * ```
 * The effect `fetch` owns the mount's claim (default `["/api/*"]`): inside
 * them its responses — 404s included — are final; outside them Octane
 * serves. Exclusion globs (`"!/api/pages"`) hand a path back to Octane.
 *
 * @section Calling RPC Methods
 * @example From server code
 * ```typescript
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * const backend = createClient(Backend);
 * const text = await backend.hello();
 * ```
 * Non-`fetch` methods are RPC methods for trusted server code — dispatch
 * is in-process, no HTTP hop. Browser code is untrusted: it reaches the
 * backend through `fetch` — mount a schema-validated surface (effect
 * `HttpApi` / `@effect/rpc`) under the mount's claim.
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
 * Event handlers deploy on a sibling Lambda (`<SiteId>-Handlers`) built
 * from the same module. Delivery engages on deploy — `alchemy dev` does
 * not dispatch queue events locally.
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
        lambdaServeBridge.attach(effectClass(makeOctane(id, props, impl)))
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
