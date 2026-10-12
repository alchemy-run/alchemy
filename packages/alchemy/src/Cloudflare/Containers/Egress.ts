/**
 * Container egress: the Durable Object that owns a container intercepts the
 * container's outbound HTTP(S), decides each request, adds credentials, and
 * forwards it. Credentials stay in the Worker; the container only ever sees
 * placeholders. See ./EGRESS.md.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ContainerApplication } from "./ContainerApplication.ts";

/** The `ctx.props` key that marks a Worker `fetch` as an intercepted container request. */
export const EGRESS_PROPS_KEY = "alchemyEgress";

/** The Durable Object RPC method an intercepted request is delivered to. */
export const EGRESS_METHOD = "__alchemyEgress";

/** The key whose requests are refused: a host taken out of the live set. */
export const EGRESS_DENIED = "~denied";

/** What the Worker entrypoint receives in `ctx.props` for an intercepted request. */
export interface EgressRoute {
  /** The Durable Object class that owns the container (its `ctx.exports` name). */
  readonly className: string;
  /** The Durable Object's id (`id.toString()`). */
  readonly id: string;
  /** The egress that handles the request, or {@link EGRESS_DENIED}. */
  readonly key: string;
}

/** Env the container gets from the egress (placeholders, the CA trust switch). */
export interface EgressContainerConfig {
  readonly env?: Record<string, string>;
}

/**
 * What an egress does with one request: return the request to forward
 * (rewritten, e.g. with credentials added), or a response to answer with
 * instead (e.g. a refusal).
 */
export type EgressHandler<R = never> = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<
  HttpClientRequest.HttpClientRequest | HttpServerResponse.HttpServerResponse,
  never,
  R
>;

const EgressTypeId = "~alchemy/Egress" as const;

/**
 * Outbound access for a container: the hosts it intercepts and what happens
 * to their requests. Create one with {@link Egress} (or a preset such as
 * `GitHub.Egress`) in a Durable Object, then pass it to the container's
 * `start({ egress })` / `setEgress`.
 */
export interface Egress {
  readonly [EgressTypeId]: typeof EgressTypeId;
  /** Unique within its Durable Object; narrowed egresses derive their own. */
  readonly key: string;
  /** Hosts intercepted on ports 80 and 443 (`*` for every host). */
  readonly hosts: ReadonlyArray<string>;
  /** Handles one intercepted request, inside the Durable Object. */
  readonly handle: (request: Request) => Effect.Effect<Response, never, RuntimeContext>;
}

export const isEgress = (value: unknown): value is Egress =>
  typeof value === "object" && value !== null && EgressTypeId in value;

/** Turn an {@link EgressHandler} into the request handler an {@link Egress} runs. */
export const makeEgressHandle =
  <R>(handler: EgressHandler<R>) =>
  (request: Request): Effect.Effect<Response, never, RuntimeContext | R> =>
    Effect.gen(function* () {
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()));
      let outgoing = HttpClientRequest.make(request.method as "GET")(request.url).pipe(
        HttpClientRequest.setHeaders(Object.fromEntries(request.headers.entries())),
      );
      if (body !== undefined && body.byteLength > 0) {
        outgoing = HttpClientRequest.bodyUint8Array(
          outgoing,
          body,
          request.headers.get("content-type") ?? undefined,
        );
      }
      const decided = yield* handler(outgoing);
      if (HttpServerResponse.isHttpServerResponse(decided)) {
        return HttpServerResponse.toWeb(decided);
      }
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(decided).pipe(
        Effect.map((r) => HttpServerResponse.toWeb(HttpServerResponse.fromClientResponse(r))),
        Effect.catch((error) =>
          Effect.succeed(
            new Response(`alchemy egress: upstream request failed: ${error.message}`, {
              status: 502,
            }),
          ),
        ),
      );
      return response;
    }).pipe(Effect.provide(FetchHttpClient.layer));

/** Answer an intercepted request with a refusal the program can read. */
export const refuse = (reason: string, status = 403) =>
  HttpServerResponse.text(`alchemy egress: ${reason}\n`, { status });

/**
 * Build an {@link Egress} value. Presets use this with their own handler and
 * hosts; {@link Egress} is the general form.
 */
export const makeEgress = (options: {
  readonly key: string;
  readonly hosts: ReadonlyArray<string>;
  readonly handle: (request: Request) => Effect.Effect<Response, never, RuntimeContext>;
}): Egress => ({ [EgressTypeId]: EgressTypeId, ...options });

/**
 * Configure the container side of an egress from the Durable Object: the
 * placeholder env its programs need, and the switch that makes the container
 * trust the interception CA. Deploy-time only.
 */
export const bindEgressIntoContainer = (
  container: unknown,
  key: string,
  config: EgressContainerConfig,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const application = (yield* (container as { Application: Effect.Effect<ContainerApplication> })
      .Application) as ContainerApplication;
    yield* application.bind`Egress(${key})`({
      env: { ...config.env, ALCHEMY_EGRESS_CA: "1" },
    });
  });

/**
 * An egress for a container: requests to `hosts` (a host, a list, or `*`)
 * from the container are handed to `handler` in this Durable Object, which
 * returns the request to forward (e.g. with credentials added) or a response
 * to answer with. Declare egresses at the top of the Durable Object that owns
 * the container; select them with `start({ egress })`.
 *
 * ### Adding credentials to an API
 * **Example:** A bearer token the container never sees
 * ```typescript
 * export class Box extends Cloudflare.DurableObject<Box>()(
 *   "Box",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *     const key = yield* Config.Redacted("STRIPE_KEY");
 *     const stripe = yield* Cloudflare.Egress(Sandbox, "api.stripe.com", (request) =>
 *       Effect.succeed(HttpClientRequest.bearerToken(request, key)),
 *     );
 *     return Effect.gen(function* () {
 *       return {
 *         run: (cmd: string[]) =>
 *           sandbox.start({ egress: [stripe] }).pipe(
 *             Effect.andThen(sandbox.exec(cmd)),
 *             Effect.flatMap((child) => child.output()),
 *             Effect.scoped,
 *           ),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const Egress = <R = never>(
  container: unknown,
  hosts: string | ReadonlyArray<string>,
  handler: EgressHandler<R>,
  options: { readonly key?: string; readonly env?: Record<string, string> } = {},
): Effect.Effect<Egress, never, R> =>
  Effect.gen(function* () {
    const list = typeof hosts === "string" ? [hosts] : hosts;
    const key = options.key ?? list.join(",");
    yield* bindEgressIntoContainer(container, key, { env: options.env });
    const context = yield* Effect.context<R>();
    return makeEgress({
      key,
      hosts: list,
      handle: (request) => makeEgressHandle(handler)(request).pipe(Effect.provideContext(context)),
    });
  });

//#region registry (runtime, inside the Durable Object)

/** The class name of each Durable Object instance, set by its bridge. */
const classNames = new WeakMap<object, string>();
/** The egresses applied to each Durable Object's container, by key. */
const registries = new WeakMap<object, Map<string, Egress>>();

/** @internal Called by the Durable Object bridge for every instance. */
export const registerDurableObjectClass = (state: object, className: string) => {
  classNames.set(state, className);
};

/** @internal Make `egress` answerable for this Durable Object's container. */
export const registerEgress = (state: object, egress: Egress) => {
  let registry = registries.get(state);
  if (!registry) {
    registry = new Map();
    registries.set(state, registry);
  }
  registry.set(egress.key, egress);
};

/** @internal The route for `key` on this Durable Object, as `ctx.props`. */
export const egressRoute = (state: cf.DurableObjectState, key: string): EgressRoute => {
  const className = classNames.get(state);
  if (className === undefined) {
    throw new Error("Container egress is only available inside an Alchemy Durable Object.");
  }
  return { className, id: state.id.toString(), key };
};

/** @internal Handle a request the Worker entrypoint forwarded to this Durable Object. */
export const dispatchEgress = (
  state: object,
  key: string,
  request: Request,
): Effect.Effect<Response, never, RuntimeContext> => {
  if (key === EGRESS_DENIED) {
    return Effect.succeed(
      new Response("alchemy egress: this host is not allowed\n", { status: 403 }),
    );
  }
  const egress = registries.get(state)?.get(key);
  return egress
    ? egress.handle(request)
    : Effect.succeed(
        new Response(`alchemy egress: ${key} is not active for this container\n`, {
          status: 403,
        }),
      );
};

//#endregion
