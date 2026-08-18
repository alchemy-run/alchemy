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
   * Server delivery + Lambda tuning (the edge routes `/api/*` to
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
 * can re-import it. Use narrow subpath imports (`alchemy/AWS/S3`) — never
 * the `alchemy/AWS` barrel — from a site module.
 *
 * @section The Mount
 * @example server/middleware/alchemy.ts
 * ```typescript
 * import { mount } from "alchemy/Serve";
 * import { defineEventHandler, toWebRequest } from "h3";
 * import Site from "../backend.ts";
 *
 * const site = mount(Site, { routes: ["/api/*", "!/api/pages"] });
 *
 * export default defineEventHandler((event) => site.fetch(toWebRequest(event)));
 * ```
 * HTTP composition is yours (Serve/DESIGN.md): the mount is an ordinary
 * nitro server middleware — dispatch order, gates, and effect routing
 * live there as plain code, in `nuxt dev` and the deployed Lambda alike.
 * `site.fetch(request)` resolves `undefined` outside the mount's `routes`
 * claim (exclusion globs like `"!/api/pages"` hand a path back to nitro),
 * so nitro continues to its own routes and pages; inside the claim the
 * effect fetch is authoritative — its responses, 404s included, are
 * final. On AWS there is no env/ctx to pass: env resolves from
 * `process.env` and the request scope settles inline before the response
 * (Lambda semantics).
 *
 * @section Server Routes
 * @example Keep API paths off the static tier
 * ```typescript
 * export default class Site extends Nuxt<Site>()(
 *   "Site",
 *   {
 *     main: import.meta.url,
 *   },
 *   Effect.gen(function* () {
 *     return { fetch: HttpServerResponse.text("hello") };
 *   }),
 * ) {}
 * ```
 * The effect claim (`["/api/*"]`) compiles into the CloudFront
 * edge router so an API path always reaches the server Lambda and can
 * never be shadowed by a static file. Runtime route OWNERSHIP is the
 * mount's `routes` claim — code in your middleware, not config here.
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
 * Event handlers dispatch on the site's OWN server Lambda (the
 * single-handler entry, Serve/DESIGN.md): the event-source mapping and
 * its IAM target the server function itself — no sibling deploys. Under
 * `alchemy dev` the queue and consumer run in the local Lambda emulator.
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
        // The class carries the AWS serve shell so the user's
        // `mount(Site)` (in a nitro server middleware) dispatches through
        // the Lambda/Node layer recipe instead of the Cloudflare bridge.
        lambdaServeBridge.attach(effectClass(makeNuxt(id, props, impl)))
    : makeNuxt(id, props, impl)) as any;

const nuxtConfig = (id: string, props: NuxtProps): FrameworkSiteConfig => ({
  name: "Nuxt",
  framework: NUXT_FRAMEWORK_SPECIFIER,
  target: NUXT_AWS_TARGET_SPECIFIER,
  options: props.nuxt ? { nuxt: props.nuxt } : undefined,
  // Single-handler (mount) delivery: the AWS deploy target's build child
  // generates the composite Lambda entry —
  // `makeFrameworkFunctionHandler({ site, streamHandler })` delegating
  // nitro's aws-lambda streaming handler (with the user's
  // `server/middleware` mount inside it) verbatim, while the program's
  // queue/schedule listeners dispatch on the SAME function. Only
  // consulted on the impl arms; plain sites are untouched.
  effectOptions: ({ mainPath }) => ({
    effect: { id, main: mainPath },
  }),
  singleHandler: true,
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
