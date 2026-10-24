/**
 * The relay a Cloudflare container's intercepted requests go through
 * (Egress/DESIGN.md §8): the Durable Object that owns the container
 * intercepts each routed host into its own Worker's `AlchemyEgress`
 * entrypoint, with that host's routes and granted egress in `ctx.props`.
 * The relay runs in the Worker, never in the Durable Object. It gets each
 * gateway's grant lazily, from the Durable Object that granted the egress
 * (which mints through the gateway's `GatewayClient`: a service binding RPC
 * for a Worker, `lambda:InvokeFunction` for a Lambda), and caches it in the
 * isolate: the props never hold a grant, so renewing one never re-registers
 * an intercept (which resets TLS handshakes in flight). Traffic goes over
 * the gateway's service binding when it has one (a Worker), and to its URL
 * otherwise (a Lambda function URL).
 *
 * This module is part of the runtime bridge entry (`@alchemy.run/cloudflare/Bridge`):
 * keep its imports lean.
 */
import type * as cf from "@cloudflare/workers-types";
import { canonicalJson } from "alchemy/Egress/Canonical";
import { type MintReply, mintFor } from "alchemy/Egress/Clients";
import type { EgressRef } from "alchemy/Egress/Kind";
import { gatewayBindingName, mostSpecific, type Route } from "alchemy/Egress/Route";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";

/** The named entrypoint the generated Worker entry exports for container egress. */
export const RELAY_ENTRYPOINT = "AlchemyEgress";

/** The Durable Object RPC method a control request is delivered to. */
export const CONTROL_METHOD = "__alchemyControl";

/** The Durable Object RPC method the relay asks for a gateway's grant. */
export const MINT_METHOD = "__alchemyEgressMint";

/** The Durable Object that granted a host's egress (it mints for the relay). */
export interface EgressOwner {
  /** The Durable Object class (its `ctx.exports` name). */
  readonly className: string;
  /** The Durable Object's id (`id.toString()`). */
  readonly id: string;
}

/** A host the owning Durable Object answers itself (e.g. a harness's shutdown hook). */
export interface ControlTarget {
  /** The Durable Object class (its `ctx.exports` name). */
  readonly className: string;
  /** The Durable Object's id (`id.toString()`). */
  readonly id: string;
  /** The control that answers. */
  readonly key: string;
}

/** A route as the relay sees it: no grant (the relay mints it). */
export type RelayRoute = Omit<Route, "grant">;

/** What the relay receives in `ctx.props` for one intercepted host. */
export interface RelayProps {
  /** The host's routes; empty: the host is refused. */
  readonly routes?: ReadonlyArray<RelayRoute>;
  /**
   * Each routed gateway's granted egress (all of it: one grant per gateway),
   * by gateway id. The relay mints the gateway's grant for exactly these.
   */
  readonly egress?: Readonly<Record<string, ReadonlyArray<EgressRef>>>;
  /** Each grant's lifetime, in milliseconds. */
  readonly ttl?: number;
  /** The Durable Object that granted the egress: the relay asks it to mint. */
  readonly owner?: EgressOwner;
  /** Answered by the owning Durable Object instead of a gateway. */
  readonly control?: ControlTarget;
}

const deny = (reason: string, status = 403) =>
  new Response(`alchemy egress: ${reason}\n`, { status });

//#region grants (isolate-scoped cache of plain values)

/** Renew a cached grant once it is within this fraction of its lifetime of expiring. */
const RENEWAL_MARGIN = 0.4;
/** How long a request waits on another request's mint before minting itself. */
const SHARED_MINT_TIMEOUT = 10_000;

interface CachedGrant {
  readonly grant: string;
  readonly expires: number;
  /** Mint again from here on (requests in flight keep the grant they started with). */
  readonly renewAt: number;
}

/** Minted grants by (gateway, canonical refs, ttl): plain strings and numbers only. */
const grants = new Map<string, CachedGrant>();
/** Mints in flight, so concurrent requests for one key mint once. */
const minting = new Map<string, Promise<CachedGrant>>();

class MintRefused extends Error {}

type DurableObjectStub = Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>>;

const ownerStub = (
  exports: Record<string, unknown> | undefined,
  owner: { readonly className: string; readonly id: string },
): DurableObjectStub | undefined => {
  const namespace = exports?.[owner.className] as cf.DurableObjectNamespace | undefined;
  return namespace
    ? (namespace.get(namespace.idFromString(owner.id)) as unknown as DurableObjectStub)
    : undefined;
};

/** Ask the owning Durable Object to mint through the gateway's client. */
const mintOver = async (
  owner: DurableObjectStub,
  gateway: string,
  refs: ReadonlyArray<EgressRef>,
  ttl: number,
): Promise<CachedGrant> => {
  const reply = (await owner[MINT_METHOD]!(gateway, refs, ttl)) as MintReply;
  if ("refused" in reply) throw new MintRefused(reply.refused);
  if ("error" in reply) throw new Error(reply.error);
  const { grant, expires } = reply;
  return { grant, expires, renewAt: expires - Math.floor(ttl * RENEWAL_MARGIN) };
};

const timeout = (millis: number) =>
  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), millis));

/**
 * The grant for `refs` at `gateway`: cached until it nears expiry, minted
 * by the owning Durable Object otherwise. A mint another request
 * started is shared, but awaited for at most {@link SHARED_MINT_TIMEOUT}
 * (its I/O belongs to that request; if it goes away, mint again).
 */
const grantFor = async (
  owner: DurableObjectStub,
  gateway: string,
  refs: ReadonlyArray<EgressRef>,
  ttl: number,
): Promise<string> => {
  const key = `${gateway}\n${ttl}\n${canonicalJson(refs)}`;
  const cached = grants.get(key);
  if (cached && Date.now() < cached.renewAt) return cached.grant;
  const shared = minting.get(key);
  if (shared) {
    const done = await Promise.race([shared.catch(() => undefined), timeout(SHARED_MINT_TIMEOUT)]);
    if (done) return done.grant;
  }
  const mint = mintOver(owner, gateway, refs, ttl);
  minting.set(key, mint);
  try {
    const minted = await mint;
    const now = Date.now();
    for (const [k, g] of grants) if (g.expires <= now) grants.delete(k);
    grants.set(key, minted);
    return minted.grant;
  } catch (error) {
    // A gateway that can't mint: a still-valid grant beats failing.
    if (cached && Date.now() < cached.expires && !(error instanceof MintRefused)) {
      return cached.grant;
    }
    throw error;
  } finally {
    if (minting.get(key) === mint) minting.delete(key);
  }
};

//#endregion

/**
 * Send a container's request to its route's gateway, with a grant minted
 * for the host's egress: over the gateway's service binding (a Worker, no
 * public hop), or to its URL (a Lambda function URL). The body is streamed,
 * never buffered.
 */
const toGateway = async (
  request: Request,
  route: RelayRoute,
  props: RelayProps,
  ctx: { readonly exports?: Record<string, unknown> },
  env: Record<string, unknown> | undefined,
): Promise<Response> => {
  const gateway = route.gateway.id;
  const binding = env?.[gatewayBindingName(gateway)] as cf.Fetcher | undefined;
  const refs = props.egress?.[gateway];
  const owner = props.owner && ownerStub(ctx.exports, props.owner);
  if (!owner || !refs?.length || props.ttl === undefined) {
    return deny(`gateway ${gateway} has no grant for this host`, 502);
  }
  if (!binding?.fetch && !route.gateway.url) {
    return deny(`gateway ${gateway} is not bound to this Worker`, 502);
  }
  let grant: string;
  try {
    grant = await grantFor(owner, gateway, refs, props.ttl);
  } catch (error) {
    return error instanceof MintRefused
      ? deny(`gateway ${gateway} refused: ${error.message}`)
      : deny(`gateway ${gateway} could not mint a grant: ${String(error)}`, 502);
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Macaroon ${grant}`);
  headers.set("x-alchemy-target", request.url);
  headers.set("x-alchemy-method", request.method);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    ...(hasBody ? { body: request.body } : {}),
  };
  if (binding?.fetch) {
    const url = route.gateway.url || "https://alchemy-egress-gateway.invalid/";
    return binding.fetch(url, init as cf.RequestInit) as unknown as Promise<Response>;
  }
  return fetch(route.gateway.url, init);
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
  return toGateway(request, route, props, ctx, env).catch((error: unknown) =>
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

/**
 * @internal Mint gateway `gateway`'s grant for the relay, through the
 * client this Durable Object yielded (DESIGN.md §6: one `GatewayClient.mint`
 * whichever host serves the gateway).
 */
export const dispatchMint = (gateway: string, refs: ReadonlyArray<EgressRef>, ttl: number) =>
  mintFor(gateway, refs, ttl);

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
