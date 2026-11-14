import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Output from "./Output.ts";
import type { HostRuntimeContext } from "./Runtime/Process.ts";
import { RuntimeContext, type BaseRuntimeContext } from "./RuntimeContext.ts";
import { Self } from "./Self.ts";

/**
 * A host that receives HTTP deliveries from an external service, such as
 * Stripe or GitHub webhooks. Event sources (`Stripe.ConsumeEventsLive`,
 * `GitHub.RepositoryEventSourceLive`) are written against it, so they don't
 * depend on the platform the host runs on.
 *
 * Hosts provide it themselves (see `RuntimeContext.hostServices`), so user
 * code only provides the event source. A secret bound with {@link
 * WebhookHostService.bind} is read back at runtime through `RuntimeContext`.
 *
 * Cloudflare Workers provide it, and so do process hosts that opt in with
 * {@link withWebhookHost} (`AWS.EC2.Instance`, `AWS.ECS.Service`). A program whose HTTP server Alchemy does not run serves
 * the claims of a {@link makeWebhookRoutes} table from its own router.
 */
export interface WebhookHostService {
  /** Logical ID of the host. Deploy-time resources are namespaced under it. */
  readonly LogicalId: string;
  /** The host's public base URL, without a trailing slash. */
  readonly url: Output.Output<string | undefined>;
  /**
   * Attach environment variables to the host as a binding under `id`. Unlike
   * a prop, a binding may depend on resources that depend on the host, such
   * as a webhook endpoint pointing at its `url`.
   */
  readonly bind: (id: string, data: { env: Record<string, unknown> }) => Effect.Effect<void>;
  /**
   * Claim requests whose URL pathname is exactly `path` (no trailing-slash
   * normalization). One handler per path; claiming a path twice is a defect.
   * Requests on any other path fall through to the host's own handler.
   */
  readonly route: <Req>(
    path: string,
    handler: (request: Request) => Effect.Effect<Response, never, Req>,
  ) => Effect.Effect<void, never, Req>;
}

export class WebhookHost extends Context.Service<WebhookHost, WebhookHostService>()(
  "alchemy/WebhookHost",
) {}

/**
 * The paths claimed through {@link WebhookHostService.route} and the handler
 * of each. A host serves the table from its own HTTP entry: it calls
 * {@link WebhookRoutes.handle} for every request and answers with the
 * handler's response when a path matches.
 */
export interface WebhookRoutes {
  readonly route: WebhookHostService["route"];
  /**
   * The response of the handler that claimed the request's pathname, or
   * `undefined` when no handler claimed it (the request is the host's own).
   */
  readonly handle: (request: Request) => Effect.Effect<Response> | undefined;
  /** Whether a handler claimed `pathname`. */
  readonly has: (pathname: string) => boolean;
}

/**
 * Make an empty {@link WebhookRoutes} table for the host named `owner`.
 * `route` keeps the services of the caller that claims a path, so `handle`
 * needs none. Claiming a path twice is a defect.
 *
 * A program that serves HTTP itself (an existing Node or Bun server whose
 * process Alchemy does not deploy) provides {@link WebhookHost} with this
 * table's `route` and calls `handle` from its router:
 *
 * ```typescript
 * const routes = WebhookHost.makeWebhookRoutes("Api");
 * const host = Layer.succeed(WebhookHost, {
 *   LogicalId: "Api",
 *   url: Output.literal("https://api.example.com"),
 *   bind: () => Effect.void,
 *   route: routes.route,
 * });
 *
 * // in the server's own request handler
 * const claimed = routes.handle(request);
 * if (claimed) return await Effect.runPromise(claimed);
 * ```
 */
export const makeWebhookRoutes = (owner: string): WebhookRoutes => {
  const handlers = new Map<string, (request: Request) => Effect.Effect<Response>>();
  return {
    route: <Req>(
      path: string,
      handler: (request: Request) => Effect.Effect<Response, never, Req>,
    ): Effect.Effect<void, never, Req> =>
      Effect.flatMap(Effect.context<Req>(), (context) =>
        Effect.suspend(() => {
          if (handlers.has(path)) {
            return Effect.die(
              new Error(`Host '${owner}' already has a webhook handler on ${path}`),
            );
          }
          handlers.set(path, (request) => handler(request).pipe(Effect.provideContext(context)));
          return Effect.void;
        }),
      ),
    handle: (request) => {
      let pathname: string;
      try {
        pathname = new URL(request.url).pathname;
      } catch {
        return undefined;
      }
      return handlers.get(pathname)?.(request);
    },
    has: (pathname) => handlers.has(pathname),
  };
};

/** The pathname of a server request, whose `url` may be relative. */
const pathnameOf = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  try {
    return new URL(request.url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
};

/**
 * {@link WebhookHost} for a process host built by `createHostRuntimeContext`:
 * the host resource's `url` attribute and `bind`, and a listener on the
 * host's HTTP server that claims each routed path. A program that declares
 * no `fetch` still serves its webhook paths.
 *
 * Provided by the hosts that opt in with {@link withWebhookHost}.
 *
 * @layer
 * @provides WebhookHost
 */
export const ProcessWebhookHostLive = Layer.effect(
  WebhookHost,
  Effect.gen(function* () {
    const host = (yield* Self) as unknown as {
      readonly LogicalId: string;
      readonly url?: Output.Output<string | undefined>;
      readonly bind: (id: string, data: { env: Record<string, unknown> }) => Effect.Effect<void>;
    };
    const context = (yield* RuntimeContext) as BaseRuntimeContext & Partial<HostRuntimeContext>;
    const listen = context.listen;
    if (listen === undefined) {
      return yield* Effect.die(
        new Error(`Host '${host.LogicalId}' (${context.Type}) does not accept HTTP listeners`),
      );
    }
    const routes = makeWebhookRoutes(host.LogicalId);
    yield* listen((request) => {
      const pathname = pathnameOf(request);
      if (pathname === undefined || !routes.has(pathname)) return undefined;
      return HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap((web) => routes.handle(web) ?? Effect.die("webhook route vanished")),
        Effect.map(HttpServerResponse.fromWeb),
        Effect.orElseSucceed(() => HttpServerResponse.text("Bad Request", { status: 400 })),
      );
    });
    return WebhookHost.of({
      LogicalId: host.LogicalId,
      url: host.url ?? Output.literal(undefined),
      bind: (id, data) => host.bind(id, data),
      route: routes.route,
    });
  }),
);

/**
 * Make a process host a {@link WebhookHost}: its init gets
 * {@link ProcessWebhookHostLive}, so event sources such as
 * `Stripe.ConsumeEventsLive` need no host wiring.
 *
 * ```typescript
 * createRuntimeContext: (id) =>
 *   withWebhookHost(createHostRuntimeContext("AWS.EC2.Instance")(id)),
 * ```
 */
export const withWebhookHost = <Ctx extends HostRuntimeContext>(context: Ctx): Ctx =>
  Object.assign(context, {
    hostServices:
      context.hostServices === undefined
        ? ProcessWebhookHostLive
        : Layer.merge(context.hostServices, ProcessWebhookHostLive),
  });
