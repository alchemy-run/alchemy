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
   * Server delivery + Lambda tuning (the edge routes `/api/*` to
   * `["/api/*"]`).
   */
  server?: EffectFrameworkServerProps;
}

/**
 * Deploy a [Waku](https://waku.gg) application to AWS: the RSC server on a
 * streaming Lambda Function URL, static assets (SSG pages included) in S3,
 * and CloudFront routing between them.
 *
 * Requires `@alchemy.run/frontend-frameworks` in your project.
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
 * @example Add an Effect backend
 * ```typescript
 * // src/backend.ts
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { Waku } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends Waku<Site>()(
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
 * can re-import it; mount the program in a waku middleware
 * (`src/middleware/*.ts`) via `alchemy/Serve` — it runs identically under
 * `waku dev`, `alchemy dev`, and in production:
 *
 * ```typescript
 * // src/middleware/mount.ts
 * import { mount } from "alchemy/Serve";
 * import Site from "../backend.ts";
 * const site = mount(Site);
 * export default () => async (c, next) =>
 *   (await site.fetch(c.req.raw)) ?? (await next(), undefined);
 * ```
 *
 * Use narrow subpath imports (`alchemy/AWS/S3`) — never
 * the `alchemy/AWS` barrel — from a site module.
 *
 * @section Server Routes
 * @example Claim paths for the effect fetch
 * ```typescript
 * export default class Site extends Waku<Site>()(
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
 * them its responses — 404s included — are final; outside them Waku
 * serves. Exclusion globs (`"!/api/pages"`) hand a path back to Waku.
 *
 * @section Calling RPC Methods
 * @example From server code
 * ```typescript
 * // an RSC handler or server function
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
 * Event handlers dispatch on the site's OWN server Lambda (single-handler
 * delivery): the event-source mapping and its IAM target the server
 * function, whose generated entry routes SQS batches and schedules
 * through the program's registered listeners.
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
        lambdaServeBridge.attach(effectClass(makeWaku(id, props, impl)))
    : makeWaku(id, props, impl)) as any;

const wakuConfig = (props: WakuProps): FrameworkSiteConfig => ({
  name: "Waku",
  framework: WAKU_FRAMEWORK_SPECIFIER,
  target: WAKU_AWS_TARGET_SPECIFIER,
  options: props.waku ? { waku: props.waku } : undefined,
  // Single-handler (mount) delivery, Serve/DESIGN.md AWS phase 4: the AWS
  // deploy target's generated Lambda entry is
  // `makeFrameworkFunctionHandler({ site, fetch })` — waku's fetch (with
  // the user's mount middleware inside it) serves ALL HTTP verbatim, and
  // the program's queue/schedule listeners dispatch on the SAME function.
  // Only consulted on the impl arms; plain sites are untouched.
  effectOptions: ({ mainPath }) => ({
    effect: { main: mainPath },
  }),
  singleHandler: true,
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
