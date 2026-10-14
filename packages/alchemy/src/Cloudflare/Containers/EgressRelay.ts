/**
 * The relay a Cloudflare container's intercepted requests go through
 * (Egress/DESIGN.md §8): the Durable Object that owns the container
 * intercepts each routed host into its own Worker's `AlchemyEgress`
 * entrypoint, with that host's routes in `ctx.props`. The relay runs in the
 * Worker, never in the Durable Object, and the container can't read the
 * props (they hold the grants).
 *
 * This module is part of the runtime bridge entry (`alchemy/Cloudflare/Bridge`):
 * keep its imports lean.
 */
import type * as cf from "@cloudflare/workers-types";
import type { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { gatewayBindingName, mostSpecific, type Route } from "../../Egress/Route.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";

/** The named entrypoint the generated Worker entry exports for container egress. */
export const RELAY_ENTRYPOINT = "AlchemyEgress";

/** The Durable Object RPC method a control request is delivered to. */
export const CONTROL_METHOD = "__alchemyControl";

/** A host the owning Durable Object answers itself (e.g. a harness's shutdown hook). */
export interface ControlTarget {
  /** The Durable Object class (its `ctx.exports` name). */
  readonly className: string;
  /** The Durable Object's id (`id.toString()`). */
  readonly id: string;
  /** The control that answers. */
  readonly key: string;
}

/** What the relay receives in `ctx.props` for one intercepted host. */
export interface RelayProps {
  /** The host's routes; empty: the host is refused. */
  readonly routes?: ReadonlyArray<Route>;
  /** Answered by the owning Durable Object instead of a gateway. */
  readonly control?: ControlTarget;
}

const deny = (reason: string, status = 403) =>
  new Response(`alchemy egress: ${reason}\n`, { status });

/**
 * Send a container's request to its route's gateway: the gateway's service
 * binding when this Worker has one (no public hop), else its URL. The body
 * is streamed, never buffered.
 */
const toGateway = (request: Request, route: Route, env: Record<string, unknown> | undefined) => {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Macaroon ${route.grant}`);
  headers.set("x-alchemy-target", request.url);
  headers.set("x-alchemy-method", request.method);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    ...(hasBody ? { body: request.body } : {}),
  };
  const url = route.gateway.url || "https://alchemy-egress-gateway.invalid/";
  const binding = env?.[gatewayBindingName(route.gateway.id)] as cf.Fetcher | undefined;
  return binding
    ? (binding.fetch(url, init as cf.RequestInit) as unknown as Promise<Response>)
    : fetch(url, init);
};

/** Hand a control request to the Durable Object that registered it. */
const toObject = (
  exports: Record<string, unknown> | undefined,
  target: ControlTarget,
  request: Request,
) => {
  const namespace = exports?.[target.className] as cf.DurableObjectNamespace | undefined;
  if (!namespace) return Promise.resolve(deny(`no Durable Object class ${target.className}`, 500));
  const stub = namespace.get(namespace.idFromString(target.id)) as unknown as Record<
    string,
    (key: string, request: Request) => Promise<Response>
  >;
  return stub[CONTROL_METHOD]!(target.key, request);
};

/** The relay's `fetch`: pick the most specific route by host and path, or send it straight out. */
export const relayEgress = (
  ctx: { readonly props?: unknown; readonly exports?: Record<string, unknown> },
  env: Record<string, unknown> | undefined,
  request: Request,
): Promise<Response> => {
  const props = (ctx.props ?? {}) as RelayProps;
  if (props.control) return toObject(ctx.exports, props.control, request);
  const routes = props.routes ?? [];
  if (routes.length === 0) return Promise.resolve(deny("this host is not allowed"));
  const url = new URL(request.url);
  const route = mostSpecific(routes, url.hostname, `${url.pathname}${url.search}`);
  // Not an egress request (a path no route claims): straight out, no credential.
  if (!route) return fetch(request);
  return toGateway(request, route, env).catch((error: unknown) =>
    deny(`gateway ${route.gateway.id} could not be reached: ${String(error)}`, 502),
  );
};

/**
 * The `AlchemyEgress` entrypoint class, exported by the generated Worker
 * entry of every Worker with Durable Objects. It never touches the Worker's
 * own `fetch`.
 */
export const makeEgressRelay = (Base: typeof WorkerEntrypoint): typeof WorkerEntrypoint =>
  class AlchemyEgress extends Base {
    override fetch(request: Request): Promise<Response> {
      const self = this as unknown as {
        readonly ctx: { readonly props?: unknown; readonly exports?: Record<string, unknown> };
        readonly env: Record<string, unknown>;
      };
      return relayEgress(self.ctx, self.env, request);
    }
  } as unknown as typeof WorkerEntrypoint;

//#region controls (runtime, inside the Durable Object)

/** A host the owning Durable Object answers itself. */
export interface EgressControl {
  /** Unique within the Durable Object. */
  readonly key: string;
  /** The host the container calls (over HTTP or HTTPS). */
  readonly host: string;
  readonly handle: (request: Request) => Effect.Effect<Response, never, RuntimeContext>;
}

/** The class name of each Durable Object instance, set by its bridge. */
const classNames = new WeakMap<object, string>();
const controls = new WeakMap<object, Map<string, EgressControl>>();

/** @internal Called by the Durable Object bridge for every instance. */
export const registerDurableObjectClass = (state: object, className: string) => {
  classNames.set(state, className);
};

/** @internal The class name the bridge registered for `state`. */
export const durableObjectClassOf = (state: object) => classNames.get(state);

/** @internal Answer `control.host` from this Durable Object (applied with its container's egress). */
export const registerControl = (state: object, control: EgressControl) => {
  let registry = controls.get(state);
  if (!registry) {
    registry = new Map();
    controls.set(state, registry);
  }
  registry.set(control.key, control);
};

/** @internal The controls registered on `state`. */
export const controlsOf = (state: object): ReadonlyArray<EgressControl> => [
  ...(controls.get(state)?.values() ?? []),
];

/** @internal Answer a control request the relay forwarded to this Durable Object. */
export const dispatchControl = (
  state: object,
  key: string,
  request: Request,
): Effect.Effect<Response, never, RuntimeContext> => {
  const control = controls.get(state)?.get(key);
  return control
    ? control.handle(request)
    : Effect.succeed(deny(`${key} is not active for this container`));
};

//#endregion
