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
 * and CloudFront routing between them.
 *
 * Requires `@alchemy.run/frontend-frameworks` in your project; the kit
 * adapter is provided for you.
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
 * @example Add an Effect backend
 * ```typescript
 * // src/backend.ts
 * import { Bucket, GetObject, GetObjectHttp } from "alchemy/AWS/S3";
 * import { SvelteKit } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Data = Bucket("Data");
 *
 * export default class Site extends SvelteKit<Site>()(
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
 * can re-import it. Use narrow subpath imports (`alchemy/AWS/S3`) — never
 * the `alchemy/AWS` barrel — from a site module.
 *
 * @section Server Routes
 * @example Claim paths for the effect fetch
 * ```typescript
 * export default class Site extends SvelteKit<Site>()(
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
 * them its responses — 404s included — are final; outside them kit
 * serves. Exclusion globs (`"!/api/pages"`) hand a path back to kit. The
 * same routing runs in front of kit's Vite dev server during
 * `alchemy dev`. An explicit `alchemy/SvelteKit` mount in
 * `hooks.server.ts` (or `server: { takeover: false }`) stands the
 * automatic delivery down.
 *
 * @section Calling RPC Methods
 * @example From a `+page.server.ts` load
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
        attachLambdaServeBridge(effectClass(makeSvelteKit(id, props, impl)))
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
