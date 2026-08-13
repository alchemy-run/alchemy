/**
 * Shared plumbing for the *effectful* AWS Website constructs — the AWS twin
 * of `Cloudflare/Website/Effectful.ts` (deliberately not reused across
 * clouds: the shapes differ in their init services and the AWS edge routes
 * through CloudFront, not `assets.runWorkerFirst`).
 */
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type {
  HttpServerError,
  RouteNotFound,
} from "effect/unstable/http/HttpServerError";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  CurrentNamespace,
  Namespace,
  type NamespaceNode,
} from "../../Namespace.ts";
import type { MainRpc, PlatformServices } from "../../Platform.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { SERVE_SHELL_KEY } from "../../Serve/constants.ts";
import { Stack } from "../../Stack.ts";
import {
  Function as LambdaFunction,
  type FunctionProps,
  type FunctionRuntimeContext,
  type FunctionServices,
} from "../Lambda/Function.ts";
import { lambdaServeShell } from "../Lambda/WebsiteHandlers.ts";

/**
 * A Website fetch handler's effect type: `HttpEffect` widened with
 * `RouteNotFound` in the error channel. On delivery paths that compose with
 * a framework (the per-framework AWS composites), the serve bridge maps a
 * `RouteNotFound` failure (or the `Serve.passthrough` subclass) to
 * delegation — the framework's own fetch serves the request. On the
 * effectful `StaticSite`, where the Effect program IS the whole server,
 * there is nothing to fall through to and a `RouteNotFound` failure is
 * answered as a plain 404 by the Lambda HTTP bridge.
 */
export type WebsiteHttpEffect<Req = never> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError | HttpBodyError | RouteNotFound,
  HttpServerRequest | Scope | Req
>;

type WebsiteMain<InitServices = never> = void | {
  fetch?:
    | WebsiteHttpEffect<
        InitServices | PlatformServices | RuntimeContext | Scope
      >
    | Effect.Effect<
        WebsiteHttpEffect<
          InitServices | PlatformServices | RuntimeContext | Scope
        >,
        never,
        InitServices | PlatformServices
      >;
};

/**
 * The shape an effectful AWS Website's Effect program may return: an
 * optional `fetch` handler (the `server.routes`-scoped API surface,
 * passthrough-capable — see {@link WebsiteHttpEffect}) plus any RPC
 * methods, exactly like an effect-native `AWS.Lambda.Function`. Every
 * member is already optional, so a program may also return nothing at all.
 */
export type WebsiteShape<Req = never> = WebsiteMain<FunctionServices | Req> &
  MainRpc<FunctionServices | Req>;

/**
 * Server-side options for an effectful AWS Website — the AWS twin of the
 * Cloudflare `WorkerServerOptions`.
 */
export interface WebsiteServerOptions {
  /**
   * Path globs the Effect `fetch` handler owns, in the
   * `assets.runWorkerFirst` glob dialect: `*` matches any run of
   * characters (including `/`), and a leading `!` marks an exclusion
   * (exclusions take precedence). Compiled into the generated
   * viewer-request CloudFront Function's `serverRoutes` check, which
   * routes matching paths to the server origin BEFORE the static-asset
   * manifest lookup — a static file can never shadow an API path, even
   * under `spa: true`.
   * @default ["/api/*"]
   */
  routes?: string[];
  /**
   * Skip the wiring-handshake sentinel scan on explicit-tier framework
   * deliveries (exotic setups). Not consulted by the effectful
   * `StaticSite`, whose Effect program IS the server.
   */
  verify?: boolean;
  /**
   * Opt out of entry takeover on frameworks that support it. Not
   * consulted by the effectful `StaticSite`.
   */
  takeover?: boolean;
}

/**
 * The default URL space an effectful Website's `fetch` handler owns when
 * `server.routes` is not configured.
 */
export const DEFAULT_SERVER_ROUTES = ["/api/*"];

/**
 * An effectful AWS Website construct was given an Effect program without
 * the `main` module anchor. The program must live in a dedicated module
 * whose default export is the Website class, anchored by
 * `main: import.meta.url` (identical to `AWS.Lambda.Function`): the
 * deployed bundle re-imports the program by path, and the dev child
 * processes receive only serialized plain data — a closure cannot cross
 * either boundary. Raised as a defect at plan time.
 */
export class WebsiteImplAnchorError extends Data.TaggedError(
  "WebsiteImplAnchorError",
)<{
  message: string;
  websiteId: string;
}> {}

/**
 * Validate the `main` anchor of an impl-carrying AWS Website construct.
 * With an Effect program, `main` is required and must be the URL/path of
 * the module default-exporting the class — dies with
 * {@link WebsiteImplAnchorError} otherwise.
 *
 * Plan-only: inside a deployed/bundled runtime (`__ALCHEMY_RUNTIME__`) the
 * class re-evaluates where `import.meta.url`-derived props may not
 * round-trip — `main` is a plan-time input, so the runtime re-evaluation
 * passes a placeholder through instead of dying.
 */
export const validateImplAnchor = (
  id: string,
  framework: string,
  main: unknown,
): Effect.Effect<string> =>
  typeof main === "string" && main.length > 0
    ? Effect.succeed(main)
    : globalThis.__ALCHEMY_RUNTIME__
      ? Effect.succeed("")
      : Effect.die(
          new WebsiteImplAnchorError({
            message:
              `AWS.Website.${framework}("${id}", ...) takes an Effect ` +
              `program, but props.main is missing. With an impl, main anchors ` +
              `the module whose default export is this class — add ` +
              `\`main: import.meta.url\` to the props and define the class in ` +
              `a dedicated module (the deployed bundle re-imports the program ` +
              `by path, so it cannot live inline in alchemy.run.ts).`,
            websiteId: id,
          }),
        );

/**
 * A `server.routes` glob was invalid for the CloudFront edge compilation.
 * Raised as a defect at plan time.
 */
export class WebsiteServerRoutingError extends Data.TaggedError(
  "WebsiteServerRoutingError",
)<{
  message: string;
  websiteId: string;
}> {}

/**
 * The compiled form of `server.routes` stored in the site's CloudFront KV
 * `:metadata` entry: anchored regex sources (the CloudFront Function
 * evaluates them with `new RegExp(...)` at the edge). Split into
 * inclusions and exclusions — a path is server-owned when it matches at
 * least one inclusion and no exclusion, mirroring `alchemy/Serve/Routes`
 * and Cloudflare's `runWorkerFirst` rule semantics.
 */
export interface CompiledServerRoutes {
  include: string[];
  exclude: string[];
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globToRegExpSource = (glob: string): string =>
  `^${glob.split("*").map(escapeRegExp).join(".*")}$`;

/**
 * Compile `server.routes` globs into the {@link CompiledServerRoutes}
 * shape the generated viewer-request CloudFront Function matches against
 * (see `matchesServerRoute` in `cfcode.ts`). Dies with
 * {@link WebsiteServerRoutingError} when a glob is not path-shaped
 * (`"/..."` or `"!/..."`), mirroring the Cloudflare-side validation.
 */
export const compileServerRoutes = (
  id: string,
  routes: readonly string[],
): Effect.Effect<CompiledServerRoutes> =>
  Effect.gen(function* () {
    const include: string[] = [];
    const exclude: string[] = [];
    if (routes.length === 0) {
      return yield* Effect.die(
        new WebsiteServerRoutingError({
          message:
            `AWS.Website("${id}"): server.routes is empty — an effectful ` +
            `Website's fetch handler needs at least one route glob ` +
            `(default ["/api/*"]).`,
          websiteId: id,
        }),
      );
    }
    for (const route of routes) {
      const isExclusion = route.startsWith("!");
      const glob = isExclusion ? route.slice(1) : route;
      if (!glob.startsWith("/")) {
        return yield* Effect.die(
          new WebsiteServerRoutingError({
            message:
              `AWS.Website("${id}"): invalid server.routes glob ` +
              `${JSON.stringify(route)} — route globs must start with "/" ` +
              `(or "!/" for exclusions), e.g. "/api/*".`,
            websiteId: id,
          }),
        );
      }
      (isExclusion ? exclude : include).push(globToRegExpSource(glob));
    }
    return { include, exclude };
  });

// ─────────────────────────────────────────────────────────────────────────
// Sibling-function non-fetch delivery (DESIGN §2.1.3)
//
// The framework-built server Lambda's entry is pre-`streamifyResponse`-
// wrapped (OpenNext, nitro's aws-lambda-streaming) — there is no entry seam
// through which event-source events (SQS batches, DynamoDB stream records,
// schedules, …) could reach the Effect program. So on AWS the non-fetch
// half of an effectful Website's program rides a SIBLING effect Lambda:
// the same `site.ts` impl deployed through the normal FunctionBundle
// pipeline (the bundle re-imports the module; the runtime world delegates
// to the Lambda platform call, whose exports handler dispatches the
// event-source listeners), with the event-source mappings and their IAM
// targeting the sibling. Invisible in the programming model — the user
// writes one impl.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Logical id of the sibling effect Lambda carrying an effectful AWS
 * Website's non-fetch (event-source) handlers: `<siteId>-Handlers`,
 * declared at the *caller's* namespace (the same level as the Website
 * itself) — exactly the FQN shape a hand-declared sibling effect Function
 * would have, and collision-free across several effectful sites at one
 * level. The impl's event-source child rows (mappings, rules) nest under
 * it because the impl evaluates with the caller-anchored namespace (see
 * `makeEffectFrameworkSite`) and event sources push `host.LogicalId`.
 */
export const siblingHandlersId = (siteId: string): string =>
  `${siteId}-Handlers`;

/**
 * Opt-in env var the `alchemy/serve` Lambda bridge
 * (`AWS/Lambda/WebsiteHandlers.ts`) honors: when set, capability clients
 * built by the bridge target this local AWS emulator gateway with the
 * emulator's fixed dummy identity instead of `Credentials.fromChain()`.
 *
 * The AWS dev model keeps capability bindings against the REAL cloud with
 * ambient credentials (capability resources are typically piped through
 * `Alchemy.remote()` under `alchemy dev`), so the composites do NOT set
 * this by default — a user whose resources live in the local emulator can
 * set it via `server.environment` (e.g. to
 * {@link DEFAULT_LOCAL_AWS_ENDPOINT}). Deliberately NOT an `AWS_*` name:
 * it is read only by the serve bridge's layer recipe, so the developer's
 * ambient credentials/endpoint stay untouched for their own code in the
 * same process.
 */
export const LOCAL_AWS_ENDPOINT_ENV = "ALCHEMY_AWS_ENDPOINT_URL";

/**
 * The local emulator gateway address (floci's default port — kept as a
 * literal so the Website graph, which frameworks compile into server
 * bundles, never imports `@alchemy.run/floci`; mirrors
 * `DEFAULT_LOCAL_ENDPOINT` in `AWS/AuthProvider.ts`).
 */
export const DEFAULT_LOCAL_AWS_ENDPOINT = "http://localhost:4566";

/**
 * Attach the AWS Lambda/Node serve shell to an effectful Website class so
 * `Serve.make(Site)` — and the framework mounts built on it
 * (`toRouteHandler`, `toEventHandler`) — dispatches through the Lambda
 * layer recipe (`Credentials.fromChain()` / `Region.fromEnv()` /
 * `process.env` markers) instead of the Cloudflare-flavored default
 * bridge. The shell rides the site module's own import graph into any
 * bundle containing the class. Called by the AWS Website constructs'
 * class arms.
 * @internal
 */
export const attachLambdaServeShell = <T>(cls: T): T =>
  Object.assign(cls as object, { [SERVE_SHELL_KEY]: lambdaServeShell }) as T;

/**
 * A no-op `bind` mirroring the dual call forms of `Resource.bind` — the
 * redirect facade swallows event-source bind rows during the site Lambda's
 * evaluation (the sibling already collected identical rows during its own
 * evaluation).
 */
const noopBind = (...args: unknown[]): unknown =>
  typeof args[0] === "string" ? Effect.void : () => Effect.void;

/**
 * The host facade the site Lambda's impl evaluation sees under the typed
 * `AWS.Lambda.Function` Self tag: everything forwards to the sibling
 * instance (`LogicalId` keeps event-source child resources on the
 * sibling's namespace, `functionName` keeps mapping declarations targeting
 * the sibling — both idempotently deduped against the sibling evaluation's
 * own declarations), while `bind`/`listen` no-op so the site evaluation
 * neither duplicates the sibling's IAM rows nor registers event-source
 * listeners on the site's runtime context (whose census must stay
 * fetch-only for the collect-only `finalizeProps` check).
 */
const makeRedirectHost = (sibling: object): object =>
  new Proxy(sibling, {
    get(target, prop, receiver) {
      if (prop === "bind") return noopBind;
      if (prop === "listen") return () => Effect.void;
      return Reflect.get(target, prop, receiver);
    },
  });

/** Options for {@link deploySiblingHandlers}. */
export interface SiblingHandlersOptions {
  /** The Website's logical id (the sibling declares as `<id>-Handlers`). */
  id: string;
  /** The user's effect module (`props.main`). */
  main: string;
  /**
   * The user's Effect program (fetch + event sources), already anchored to
   * the caller's namespace by the composite (impl-declared resources
   * register at the level the Website was declared at).
   */
  impl: Effect.Effect<any, any, any>;
  runtime?: FunctionProps["runtime"];
  architecture?: "x86_64" | "arm64";
  memorySize?: number;
  timeout?: Duration.Duration;
  env?: Record<string, any>;
}

/** Result of {@link deploySiblingHandlers}. */
export interface SiblingHandlers {
  /**
   * The sibling effect Lambda — `undefined` when the impl registered no
   * event-source listeners (fetch-only programs deploy no extra Lambda).
   */
  sibling: unknown | undefined;
  /**
   * The impl to thread into the collect-only site Lambda: the user's impl
   * with the typed `AWS.Lambda.Function` Self tag shadowed by the sibling
   * redirect facade, so event-source layers built inside the site
   * evaluation resolve the sibling as their host.
   */
  siteImpl: Effect.Effect<any, any, any>;
}

/**
 * Deploy the sibling effect Lambda for an effectful AWS Website (the
 * non-fetch delivery mechanism, DESIGN §2.1.3). Runs BEFORE the site's
 * collect-only server Lambda is declared:
 *
 * 1. The full impl (shape stripped — the sibling serves no fetch/RPC
 *    surface and gets no Function URL) deploys as a normal effect-native
 *    `AWS.Lambda.Function` at {@link SIBLING_HANDLERS_ID}: capability
 *    bindings collect the sibling's own env + IAM, and every event source
 *    registers its mapping/rule resources and listeners against the
 *    sibling.
 * 2. If the evaluation registered no listeners, the sibling's stack row
 *    (and its binding rows) are retracted — a fetch-only program deploys
 *    no extra Lambda. Resources the impl itself declared are untouched
 *    (they are shared with the site evaluation, which re-declares them
 *    idempotently).
 * 3. The returned {@link SiblingHandlers.siteImpl} shadows the typed
 *    `AWS.Lambda.Function` tag with the sibling redirect facade so the
 *    site Lambda's own evaluation (binding collection for the fetch
 *    surface) cannot re-target event sources at the framework artifact.
 *
 * At runtime the sibling's generated FunctionBundle entry re-imports
 * `site.ts`; the Website construct's `__ALCHEMY_RUNTIME__` world delegates
 * to the Lambda platform call, whose exports handler dispatches
 * event-source listeners first — HTTP never arrives (no Function URL).
 * @internal
 */
export const deploySiblingHandlers = Effect.fn("AWS.Website.SiblingHandlers")(
  function* (options: SiblingHandlersOptions) {
    // The composites call this one `Namespace.push(id)` level deep; the
    // sibling declares at the CALLER's level (the push's parent) so its
    // FQN subtree matches the impl's caller-anchored event-source rows —
    // the exact shape a hand-declared sibling effect Function would have.
    const ambient = yield* CurrentNamespace;
    const sibling = (yield* Effect.provideService(
      (LambdaFunction as any)(
        siblingHandlersId(options.id),
        {
          main: options.main,
          functionUrl: false,
          runtime: options.runtime,
          architecture: options.architecture,
          memorySize: options.memorySize ?? 1024,
          timeout: options.timeout ?? Duration.seconds(30),
          env: options.env,
        },
        // Strip the returned shape: init runs in full (event sources
        // register against this host; capability bindings collect its
        // env + IAM), but nothing is served — the fetch surface lives on
        // the site Lambda.
        options.impl.pipe(Effect.map(() => undefined)),
      ) as Effect.Effect<any, never, any>,
      Namespace,
      ambient?.Parent as NamespaceNode,
    )) as {
      FQN: string;
      RuntimeContext: FunctionRuntimeContext;
    };

    const listeners = sibling.RuntimeContext.listenerCount();
    const siteImpl = Effect.provideService(
      options.impl,
      (LambdaFunction as any).Self,
      makeRedirectHost(sibling),
    );

    if (listeners === 0) {
      // Fetch-only program: retract the sibling's row and binding rows so
      // no extra Lambda deploys. Nothing else can reference it — the
      // composite never exposes it and no event source declared against
      // it. Resources declared inside the impl stay (the site evaluation
      // shares them).
      const stack = yield* Stack;
      delete stack.resources[sibling.FQN];
      delete stack.bindings[sibling.FQN];
      return { sibling: undefined, siteImpl } satisfies SiblingHandlers;
    }

    return { sibling, siteImpl } satisfies SiblingHandlers;
  },
);
