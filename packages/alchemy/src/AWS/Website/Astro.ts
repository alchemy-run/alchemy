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
 * Deploy an [Astro](https://astro.build) application to AWS: the server on
 * a streaming Lambda Function URL, static assets (prerendered pages
 * included) in S3, and CloudFront routing between them.
 *
 * Requires `@alchemy.run/frontend-frameworks` in your project. The AWS
 * Lambda adapter is injected for you — your `astro.config.*` must not
 * declare one.
 *
 * @resource
 * @section Creating Astro Sites
 * @example Basic Astro App
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 * Pages render on demand by default; pages that
 * `export const prerender = true` are prerendered at build time and served
 * from S3.
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
 * `output: "static"` prerenders every page and deploys assets-only — no
 * Lambda (and therefore no Effect program).
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
 * @example Add an Effect backend
 * ```typescript
 * // src/backend.ts
 * import { GetItem, GetItemHttp, Table } from "alchemy/AWS/DynamoDB";
 * import { Astro } from "alchemy/AWS/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Visits = Table("Visits", {
 *   partitionKey: "pk",
 *   attributes: { pk: "S" },
 * });
 *
 * export default class Site extends Astro<Site>()(
 *   "Site",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getItem = yield* GetItem(yield* Visits);
 *     return {
 *       visits: () =>
 *         getItem({ Key: { pk: { S: "current" } } }).pipe(
 *           Effect.map((result) => result.Item),
 *         ),
 *     };
 *   }).pipe(Effect.provide(GetItemHttp)),
 * ) {}
 * ```
 * Pass an Effect program as the third argument — it runs inside the site's
 * server Lambda, and its bindings collect env vars and IAM at deploy time.
 * `main: import.meta.url` anchors the module so the server bundle can
 * re-import it. Use narrow subpath imports (`alchemy/AWS/DynamoDB`) —
 * never the `alchemy/AWS` barrel — from a site module.
 *
 * @section Server Routes
 * @example Claim paths for the effect fetch
 * ```typescript
 * export default class Site extends Astro<Site>()(
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
 * them its responses — 404s included — are final; outside them Astro
 * serves. Exclusion globs (`"!/api/pages"`) hand a path back to Astro.
 * The same routing applies in `astro dev`.
 *
 * @section Calling RPC Methods
 * @example From page frontmatter
 * ```typescript
 * ---
 * import { createClient } from "alchemy/Client";
 * import Backend from "../backend.ts";
 *
 * const backend = createClient(Backend);
 * const item = await backend.visits();
 * ---
 * ```
 * Non-`fetch` methods are RPC methods for trusted server code (the
 * frontmatter of non-prerendered pages) — dispatch is in-process, no HTTP
 * hop. Browser code is untrusted: it reaches the backend through `fetch` —
 * mount a schema-validated surface (effect `HttpApi` / `@effect/rpc`)
 * under `server.routes`.
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
        lambdaServeBridge.attach(effectClass(makeAstro(id, props, impl)))
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
  // Astro's effectful delivery is the mount design (Serve/DESIGN.md, AWS
  // phase 4): HTTP is the user's `src/fetch.ts` mount
  // (`site.fetch(request) ?? astro(new FetchState(request))`), riding
  // astro's own fetchable seam in prod and dev alike. The AWS deploy
  // target swaps the server entrypoint for a generated
  // `makeFrameworkFunctionHandler` wrapper — additive-only: astro's fetch
  // serves ALL HTTP verbatim, and the program's non-fetch listeners
  // (queue consumers, schedules) dispatch on the SAME Lambda
  // (`singleHandler` below — no sibling deploys). `takeover: false`
  // forces the explicit tier (astro's own entry, non-fetch listeners
  // rejected at plan time). The extra option rides the framework
  // `make()`'s `targetConfig` channel into the AWS deploy target's
  // config (`AstroAwsConfig.effect`).
  config.effectOptions = ({ mainPath }) => ({
    targetConfig: { effect: { main: mainPath } },
  });
  config.singleHandler = true;
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
