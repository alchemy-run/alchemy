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
 * Function URL, static assets (prerendered pages included) in S3, and
 * CloudFront routing between them.
 *
 * Requires `@alchemy.run/frontend-frameworks` in your project.
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
 * @example Add an Effect backend
 * ```typescript
 * // src/backend.ts
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { Nuxt } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends Nuxt<Site>()(
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
 * can re-import it; no route file or config edit is needed. Use narrow
 * subpath imports (`alchemy/AWS/S3`) — never the `alchemy/AWS` barrel —
 * from a site module.
 *
 * @section Server Routes
 * @example Claim paths for the effect fetch
 * ```typescript
 * export default class Site extends Nuxt<Site>()(
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
 * The effect `fetch` owns `server.routes` (default `["/api/*"]`): inside
 * them its responses — 404s included — are final; outside them nitro's
 * own handlers serve. Exclusion globs (`"!/api/pages"`) hand a path back
 * to nitro. The same routing applies in `nuxt dev`.
 *
 * @section Calling RPC Methods
 * @example From a server route
 * ```typescript
 * // a server route or `useAsyncData` server branch
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * const backend = createClient(Backend);
 * const text = await backend.hello();
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
 * Event handlers deploy on a sibling Lambda (`<SiteId>-Handlers`) built
 * from the same module. Delivery engages on deploy — `alchemy dev` does
 * not dispatch queue events locally.
 *
 * @section Mounting The Program Yourself
 * @example Server middleware mount
 * ```typescript
 * // server/middleware/alchemy.ts
 * import { toEventHandler } from "alchemy/Nitro";
 * import Site from "../../src/backend.ts";
 *
 * export default toEventHandler(Site);
 * ```
 * An explicit mount in the `server/` tree (or
 * `server: { takeover: false }`) stands the automatic delivery down.
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
        attachLambdaServeBridge(effectClass(makeNuxt(id, props, impl)))
    : makeNuxt(id, props, impl)) as any;

const nuxtConfig = (id: string, props: NuxtProps): FrameworkSiteConfig => ({
  name: "Nuxt",
  framework: NUXT_FRAMEWORK_SPECIFIER,
  target: NUXT_AWS_TARGET_SPECIFIER,
  options: props.nuxt ? { nuxt: props.nuxt } : undefined,
  // Auto-inject (wrapper) tier: the framework integration writes the
  // generated effect middleware under `<root>/.alchemy/nuxt/<id>/` and
  // injects it through `nitro.handlers` — nitro compiles config-injected
  // handlers into the aws-lambda prod bundle AND the dev SSR worker
  // through the same virtual module, so ONE mechanism delivers deploy and
  // dev dispatch. Only consulted on the impl arms; plain sites are
  // untouched.
  effectOptions: ({ mainPath, routes }) => ({
    effect: { id, main: mainPath, routes: [...routes] },
  }),
});

const makeNuxt = (
  id: string,
  props: NuxtProps = {},
  impl?: Effect.Effect<any, any, any>,
): Effect.Effect<any, never, any> =>
  impl === undefined
    ? makeFrameworkSite(id, props, nuxtConfig(id, props)).pipe(
        Namespace.push(id),
      )
    : makeEffectFrameworkSite(
        id,
        props as EffectNuxtProps,
        nuxtConfig(id, props),
        impl,
      );
