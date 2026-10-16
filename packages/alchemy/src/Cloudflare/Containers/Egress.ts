/**
 * Container egress, in the Durable Object that owns a Cloudflare container
 * (Egress/DESIGN.md §8, §10, §12). The object stores what it granted
 * (`{ ttl, egress }`) and intercepts each routed host into its Worker's
 * `AlchemyEgress` relay (EgressRelay.ts) with that host's routes, granted
 * egress and owner (this object) in the props. The props hold no grant: the
 * relay asks this object to mint when its cached grant nears expiry, so an intercept is re-registered only when its host's
 * props change (`start` with different egress, `setEgress`, `stop`).
 */
import type * as cf from "@cloudflare/workers-types";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { canonicalJson } from "../../Egress/Canonical.ts";
import {
  type EgressError,
  type GrantableEgress,
  grant,
  placeholdersFor,
} from "../../Egress/Gateway.ts";
import type { EgressRef } from "../../Egress/Kind.ts";
import type { Route } from "../../Egress/Route.ts";
import { EGRESS_CA, EGRESS_CA_BUNDLE, EGRESS_CA_SWITCH } from "../../Runtime/Bootstrap/EgressCa.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { ContainerError } from "./Container.ts";
import {
  controlsOf,
  durableObjectClassOf,
  RELAY_ENTRYPOINT,
  type RelayProps,
  type RelayRoute,
} from "./EgressRelay.ts";

export {
  CONTROL_METHOD,
  dispatchControl,
  type EgressControl,
  registerControl,
  registerDurableObjectClass,
} from "./EgressRelay.ts";

/** An egress a container can be granted: a value from `yield* SomeGateway`. */
export type ContainerEgress = GrantableEgress<any, any>;

/** What the owning Durable Object stores (DESIGN.md §12). */
export interface StoredEgress {
  /** Each grant's lifetime, in milliseconds. */
  readonly ttl: number;
  /** The granted egresses; each names its gateway. */
  readonly egress: ReadonlyArray<EgressRef>;
  /**
   * The relay props each host is intercepted with on the running container
   * (empty while it is stopped). `{ routes: [] }`: refused.
   */
  readonly hosts: Readonly<Record<string, RelayProps>>;
}

/** Each grant's lifetime unless `ttl` says otherwise. */
export const DEFAULT_TTL = Duration.minutes(5);

const STORAGE_KEY = "alchemy:egress";

const containerError = (message: string) => (cause: unknown) =>
  new ContainerError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

//#region storage

/** The stored hosts (an older shape stored only their names: re-intercept them all). */
const hostsOf = (stored: StoredEgress | undefined): Readonly<Record<string, RelayProps | null>> =>
  !stored?.hosts
    ? {}
    : Array.isArray(stored.hosts)
      ? Object.fromEntries((stored.hosts as ReadonlyArray<string>).map((h) => [h, null]))
      : stored.hosts;

export const loadEgress = (state: cf.DurableObjectState) =>
  Effect.tryPromise({
    try: () => state.storage.get<StoredEgress>(STORAGE_KEY),
    catch: containerError("reading the stored egress failed"),
  });

const saveEgress = (state: cf.DurableObjectState, stored: StoredEgress) =>
  Effect.tryPromise({
    try: () => state.storage.put(STORAGE_KEY, stored),
    catch: containerError("storing the egress failed"),
  });

/** Whether any host has routes (so the container's HTTPS is intercepted). */
export const isIntercepted = (stored: StoredEgress | undefined) =>
  Object.values(hostsOf(stored)).some((props) => props === null || !!props.routes?.length);

//#endregion

//#region routes

/** The egress `start`/`setEgress` asks for, merged over what's stored (omitted fields are kept). */
export const nextEgress = (
  stored: StoredEgress | undefined,
  options: { readonly egress?: ReadonlyArray<ContainerEgress>; readonly ttl?: Duration.Input },
): Omit<StoredEgress, "hosts"> => ({
  ttl:
    options.ttl !== undefined
      ? Duration.toMillis(options.ttl)
      : (stored?.ttl ?? Duration.toMillis(DEFAULT_TTL)),
  egress: options.egress !== undefined ? options.egress.map((e) => e.ref) : (stored?.egress ?? []),
});

/** Whether `next` is the egress already stored (and applied, when the container runs). */
export const isStored = (stored: StoredEgress | undefined, next: Omit<StoredEgress, "hosts">) =>
  stored !== undefined &&
  canonicalJson({ ttl: stored.ttl, egress: stored.egress }) ===
    canonicalJson({ ttl: next.ttl, egress: next.egress });

/**
 * The route table for `next`. Asks each gateway to mint (it checks the
 * scopes and resolves dynamic routes); the grants themselves are dropped,
 * since the relay mints its own. Conflicts and refusals fail here.
 */
const routesOf = (
  next: Omit<StoredEgress, "hosts">,
): Effect.Effect<ReadonlyArray<Route>, EgressError, RuntimeContext> =>
  next.egress.length === 0
    ? Effect.succeed([])
    : Effect.map(grant(next.egress, { ttl: Duration.millis(next.ttl) }), (g) => g.routes);

/** The env a container started with `egress` needs: placeholders, and the CA trust switch. */
export const containerEnv = (egress: ReadonlyArray<EgressRef>): Record<string, string> =>
  egress.length === 0 ? {} : { ...placeholdersFor(egress), [EGRESS_CA_SWITCH]: "1" };

/**
 * Each host's relay props: its routes (without grants), the granted egress
 * of every gateway they reach, and the ttl. A host's props change only when
 * what it may reach changes, so an unchanged host is never re-registered.
 */
const hostProps = (
  state: cf.DurableObjectState,
  next: Omit<StoredEgress, "hosts">,
  routes: ReadonlyArray<Route>,
): Record<string, RelayProps> => {
  const byGateway = new Map<string, Array<EgressRef>>();
  for (const ref of next.egress) {
    byGateway.set(ref.gateway, [...(byGateway.get(ref.gateway) ?? []), ref]);
  }
  const byHost = new Map<string, Array<RelayRoute>>();
  for (const { grant: _grant, ...route } of routes) {
    const host = route.host.toLowerCase();
    byHost.set(host, [...(byHost.get(host) ?? []), route]);
  }
  const hosts: Record<string, RelayProps> = {};
  const className = durableObjectClassOf(state);
  if (byHost.size > 0 && className === undefined) {
    throw new Error("Container egress is only available inside an Alchemy Durable Object.");
  }
  const owner = { className: className!, id: state.id.toString() };
  for (const [host, forHost] of byHost) {
    const gateways = [...new Set(forHost.map((route) => route.gateway.id))].sort();
    hosts[host] = {
      routes: forHost,
      egress: Object.fromEntries(gateways.map((id) => [id, byGateway.get(id) ?? []])),
      ttl: next.ttl,
      owner,
    };
  }
  const controls = controlsOf(state);
  if (controls.length > 0) {
    if (className === undefined) {
      throw new Error("Container controls are only available inside an Alchemy Durable Object.");
    }
    for (const control of controls) {
      const host = control.host.toLowerCase();
      if (hosts[host]) continue;
      hosts[host] = { control: { className, id: state.id.toString(), key: control.key } };
    }
  }
  return hosts;
};

const relayFor = (state: cf.DurableObjectState, props: RelayProps) => {
  const exports = (state as unknown as { exports?: Record<string, unknown> }).exports;
  const relay = exports?.[RELAY_ENTRYPOINT] as
    | ((options: { props: RelayProps }) => cf.Fetcher)
    | undefined;
  if (!relay) {
    throw new Error(
      `Container egress needs ctx.exports.${RELAY_ENTRYPOINT} (compatibility date 2025-11-01 or later, and an Effect Worker entry).`,
    );
  }
  return relay({ props });
};

/**
 * Intercept each host whose props differ from what it was last intercepted
 * with, and refuse hosts that had routes and lost them. Hosts whose props
 * are unchanged are left alone: re-registering an intercept can reset a TLS
 * handshake in flight. Returns the hosts as now intercepted.
 */
export const applyHosts = (
  state: cf.DurableObjectState,
  container: cf.Container,
  hosts: Readonly<Record<string, RelayProps>>,
  previous: Readonly<Record<string, RelayProps | null>>,
): Effect.Effect<Record<string, RelayProps>, ContainerError> =>
  Effect.tryPromise({
    try: async () => {
      // Routes are HTTPS (the gateway re-checks the target); a control
      // host answers HTTP and HTTPS.
      const intercept = async (host: string, props: RelayProps) => {
        const relay = relayFor(state, props);
        if (props.control) await container.interceptOutboundHttp(host, relay);
        await container.interceptOutboundHttps(host, relay);
      };
      const applied: Record<string, RelayProps> = {};
      for (const [host, props] of Object.entries(hosts)) {
        const before = previous[host];
        if (!before || canonicalJson(before) !== canonicalJson(props)) await intercept(host, props);
        applied[host] = props;
      }
      for (const [host, before] of Object.entries(previous)) {
        if (host in hosts) continue;
        const refused: RelayProps = { routes: [] };
        if (!before || canonicalJson(before) !== canonicalJson(refused)) {
          await intercept(host, refused);
        }
        applied[host] = refused;
      }
      return applied;
    },
    catch: containerError("applying the container's egress failed"),
  });

//#endregion

/**
 * Check `next` (each gateway mints once: scopes, dynamic routes, conflicts),
 * intercept the hosts whose props changed on the running container, then
 * store it. `fresh`: the container is about to start, so nothing is
 * intercepted yet. Fails (storing nothing) on a route conflict or a refused
 * egress.
 */
export const applyEgress = (
  state: cf.DurableObjectState,
  container: cf.Container,
  next: Omit<StoredEgress, "hosts">,
  options: { readonly fresh: boolean },
): Effect.Effect<void, EgressError | ContainerError, RuntimeContext> =>
  Effect.gen(function* () {
    const routes = yield* routesOf(next);
    const previous = options.fresh ? {} : hostsOf(yield* loadEgress(state));
    const hosts = yield* Effect.try({
      try: () => hostProps(state, next, routes),
      catch: containerError("applying the container's egress failed"),
    });
    const applied = yield* applyHosts(state, container, hosts, previous);
    yield* saveEgress(state, { ...next, hosts: applied });
  });

/** Check `next` and store it for the next `start`, without applying it (the container is stopped). */
export const storeEgress = (
  state: cf.DurableObjectState,
  next: Omit<StoredEgress, "hosts">,
): Effect.Effect<void, EgressError | ContainerError, RuntimeContext> =>
  Effect.andThen(routesOf(next), saveEgress(state, { ...next, hosts: {} }));

/** Refuse every routed host at once (the container is stopping); the stored egress stays. */
export const clearEgress = (state: cf.DurableObjectState, container: cf.Container | undefined) =>
  Effect.gen(function* () {
    const stored = yield* loadEgress(state);
    if (!stored) return;
    const previous = hostsOf(stored);
    if (container?.running && Object.keys(previous).length > 0) {
      // Control hosts stay: the container may still call them while it stops.
      const refused = Object.fromEntries(
        Object.entries(previous).map(([host, props]): [string, RelayProps] => [
          host,
          props?.control ? props : { routes: [] },
        ]),
      );
      yield* applyHosts(state, container, refused, previous).pipe(Effect.ignore);
    }
    yield* saveEgress(state, { ttl: stored.ttl, egress: stored.egress, hosts: {} });
  });

/** The container stopped on its own: nothing is intercepted any more. */
export const forgetHosts = (state: cf.DurableObjectState) =>
  Effect.gen(function* () {
    const stored = yield* loadEgress(state);
    if (stored && Object.keys(hostsOf(stored)).length > 0) {
      yield* saveEgress(state, { ttl: stored.ttl, egress: stored.egress, hosts: {} });
    }
  });

/**
 * @internal Re-register what's stored, once, when a Durable Object instance
 * is constructed while its container still runs (it was evicted, aborted or
 * redeployed). No mint: the props hold no grant.
 */
export const reapplyStored = (state: cf.DurableObjectState) =>
  Effect.gen(function* () {
    const container = state.container;
    if (!container?.running) return;
    const stored = yield* loadEgress(state);
    const hosts = hostsOf(stored);
    const className = durableObjectClassOf(state);
    const known = Object.fromEntries(
      Object.entries(hosts)
        .filter((entry): entry is [string, RelayProps] => entry[1] !== null)
        // Props stored before the relay minted through this object lack it.
        .map(([host, props]): [string, RelayProps] => [
          host,
          props.routes?.length && !props.owner && className !== undefined
            ? { ...props, owner: { className, id: state.id.toString() } }
            : props,
        ]),
    );
    if (Object.keys(known).length === 0) return;
    yield* applyHosts(state, container, known, {});
  }).pipe(
    Effect.catch((error) => Effect.logWarning("re-applying the container's egress failed", error)),
  );

/** The bundle `exec`'d commands trust: system roots plus the interception CA. */
const EXEC_CA_BUNDLE = `${EGRESS_CA_BUNDLE}.exec`;

/**
 * Runs `"$@"` trusting the egress interception CA. Commands started with
 * `exec` don't inherit the container program's environment (where
 * Runtime/Bootstrap/EgressCa.ts sets this up), and the platform writes the
 * CA shortly after the container starts with egress, so wait for it.
 */
export const TRUST_EGRESS_CA_THEN_EXEC = `i=0
while [ ! -s ${EGRESS_CA} ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
if [ -s ${EGRESS_CA} ]; then
  for roots in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
    if [ -f "$roots" ]; then cat "$roots" > ${EXEC_CA_BUNDLE}; break; fi
  done
  cat ${EGRESS_CA} >> ${EXEC_CA_BUNDLE}
  export SSL_CERT_FILE=${EXEC_CA_BUNDLE} GIT_SSL_CAINFO=${EXEC_CA_BUNDLE} NODE_EXTRA_CA_CERTS=${EXEC_CA_BUNDLE} REQUESTS_CA_BUNDLE=${EXEC_CA_BUNDLE} CURL_CA_BUNDLE=${EXEC_CA_BUNDLE}
fi
exec "$@"`;
