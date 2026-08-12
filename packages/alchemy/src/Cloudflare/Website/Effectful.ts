import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type {
  HttpServerError,
  RouteNotFound,
} from "effect/unstable/http/HttpServerError";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { MainRpc, PlatformServices } from "../../Platform.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkerServices } from "../Workers/Worker.ts";

/**
 * A Website fetch handler's effect type: `HttpEffect` widened with
 * `RouteNotFound` in the error channel. Websites always run behind the
 * serve bridge, which maps a `RouteNotFound` failure (or the
 * `Serve.passthrough` subclass) to delegation — the framework's own fetch
 * serves the request. Plain Workers have no framework to fall through to,
 * so `WorkerShape` deliberately does not admit it.
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
 * The shape an effectful Website's Effect program may return: an optional
 * `fetch` handler (the `server.routes`-scoped API surface, passthrough-
 * capable — see {@link WebsiteHttpEffect}) plus any RPC methods, exactly
 * like a Worker. Every member is already optional — the `fetch` arm is
 * all-optional and RPC methods are an index signature — so a program may
 * also return nothing at all (e.g. an impl that only registers Durable
 * Object exports).
 */
export type WebsiteShape<Req = never> = WebsiteMain<WorkerServices | Req> &
  MainRpc<WorkerServices | Req>;

/**
 * An effectful Website construct was given an Effect program without the
 * `main` module anchor. The program must live in a dedicated module whose
 * default export is the Website class, anchored by `main: import.meta.url`
 * (identical to `Cloudflare.Worker`): the deployed bundle re-imports the
 * program by path, and the dev child processes receive only serialized
 * plain data — a closure cannot cross either boundary. Raised as a defect
 * at plan time.
 */
export class WebsiteImplAnchorError extends Data.TaggedError(
  "WebsiteImplAnchorError",
)<{
  message: string;
  websiteId: string;
}> {}

/**
 * Validate the `main` anchor of an impl-carrying Website construct. With
 * an Effect program, `main` is required and must be the URL/path of the
 * module default-exporting the class — dies with
 * {@link WebsiteImplAnchorError} otherwise.
 *
 * Plan-only: inside a deployed/bundled runtime (`__ALCHEMY_RUNTIME__`) the
 * class re-evaluates with `import.meta.url` undefined (workerd modules have
 * no file URL) — `main` is a plan-time input, so the runtime re-evaluation
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
              `Cloudflare.Website.${framework}("${id}", ...) takes an Effect ` +
              `program, but props.main is missing. With an impl, main anchors ` +
              `the module whose default export is this class — add ` +
              `\`main: import.meta.url\` to the props and define the class in ` +
              `a dedicated module (the deployed bundle re-imports the program ` +
              `by path, so it cannot live inline in alchemy.run.ts).`,
            websiteId: id,
          }),
        );
