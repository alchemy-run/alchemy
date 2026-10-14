/**
 * Container egress, in the Durable Object that owns a Cloudflare container
 * (Egress/DESIGN.md §8, §10, §12). The object stores what it granted
 * (`{ ttl, egress }`), asks each gateway for a short-lived grant, and
 * intercepts each routed host into its Worker's `AlchemyEgress` relay
 * (EgressRelay.ts) with that host's routes in the props. A renewal callback
 * on the object's alarm re-mints the grants at 40% of their lifetime, and
 * re-applies what's stored after the object restarts while its container
 * runs.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { type Callback, makeCallback } from "../../Callback.ts";
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
import { onAlarmCallbacksReady } from "../Workers/AlarmCallback.ts";
import { ContainerError } from "./Container.ts";
import {
  controlsOf,
  durableObjectClassOf,
  RELAY_ENTRYPOINT,
  type RelayProps,
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
  /** The hosts intercepted when the routes were last applied (refused when they leave). */
  readonly hosts: ReadonlyArray<string>;
}

/** Each grant's lifetime unless `ttl` says otherwise. */
export const DEFAULT_TTL = Duration.minutes(5);

const STORAGE_KEY = "alchemy:egress";
const RENEWAL_CALLBACK = "alchemy/egress";
const RENEWAL_ID = "renew";

/** Renew at 40% of the TTL: one renewal can fail and the next still lands before expiry. */
const renewIn = (ttl: number) => Math.max(1_000, Math.floor(ttl * 0.4));

const containerError = (message: string) => (cause: unknown) =>
  new ContainerError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

//#region storage

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

//#endregion

//#region applied (this instance's memory)

/**
 * What this instance of the Durable Object last applied to its running
 * container: a repeated `start` with the same egress skips re-minting until
 * the renewal is due. Memory only — a restarted object has nothing here, so
 * its first `start` (or the renewal it schedules on construction) applies
 * what's stored.
 */
interface Applied {
  readonly key: string;
  readonly renewAt: number;
}
const applied = new WeakMap<object, Applied>();

/** @internal Forget what was applied (the container stopped). */
export const forgetApplied = (state: object) => applied.delete(state);

const markApplied = (state: object, next: Omit<StoredEgress, "hosts">) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    applied.set(state, {
      key: canonicalJson({ ttl: next.ttl, egress: next.egress }),
      renewAt: now + renewIn(next.ttl),
    });
  });

//#endregion

//#region routes

/** The egress `start`/`setEgress` asks for, merged over what's stored (omitted fields are kept). */
export const nextEgress = (
  stored: StoredEgress | undefined,
  options: { readonly egress?: ReadonlyArray<ContainerEgress>; readonly ttl?: Duration.Input },
): StoredEgress => ({
  ttl:
    options.ttl !== undefined
      ? Duration.toMillis(options.ttl)
      : (stored?.ttl ?? Duration.toMillis(DEFAULT_TTL)),
  egress: options.egress !== undefined ? options.egress.map((e) => e.ref) : (stored?.egress ?? []),
  hosts: stored?.hosts ?? [],
});

/** One grant per gateway, then one route table for all of them. Conflicts fail here. */
export const routesOf = (
  next: StoredEgress,
): Effect.Effect<ReadonlyArray<Route>, EgressError, RuntimeContext> =>
  next.egress.length === 0
    ? Effect.succeed([])
    : Effect.map(grant(next.egress, { ttl: Duration.millis(next.ttl) }), (g) => g.routes);

/** The env a container started with `egress` needs: placeholders, and the CA trust switch. */
export const containerEnv = (egress: ReadonlyArray<EgressRef>): Record<string, string> =>
  egress.length === 0 ? {} : { ...placeholdersFor(egress), [EGRESS_CA_SWITCH]: "1" };

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
 * Point every routed host at the relay with its routes, every control host
 * at this object, and refuse hosts that had routes and lost them. Calling
 * `interceptOutbound*` again replaces the props, on open connections too.
 * Returns the hosts that now have routes.
 */
export const applyRoutes = (
  state: cf.DurableObjectState,
  container: cf.Container,
  routes: ReadonlyArray<Route>,
  previousHosts: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, ContainerError> =>
  Effect.tryPromise({
    try: async () => {
      const byHost = new Map<string, Array<Route>>();
      for (const route of routes) {
        const host = route.host.toLowerCase();
        byHost.set(host, [...(byHost.get(host) ?? []), route]);
      }
      // Routes are HTTPS (the gateway re-checks the target); a control
      // host answers HTTP and HTTPS.
      const intercept = async (host: string, props: RelayProps, http = false) => {
        const relay = relayFor(state, props);
        if (http) await container.interceptOutboundHttp(host, relay);
        await container.interceptOutboundHttps(host, relay);
      };
      for (const [host, forHost] of byHost) await intercept(host, { routes: forHost });
      const controls = controlsOf(state);
      if (controls.length > 0) {
        const className = durableObjectClassOf(state);
        if (className === undefined) {
          throw new Error(
            "Container controls are only available inside an Alchemy Durable Object.",
          );
        }
        for (const control of controls) {
          if (byHost.has(control.host.toLowerCase())) continue;
          await intercept(
            control.host,
            { control: { className, id: state.id.toString(), key: control.key } },
            true,
          );
        }
      }
      for (const host of previousHosts) {
        if (!byHost.has(host)) await intercept(host, { routes: [] });
      }
      return [...byHost.keys()];
    },
    catch: containerError("applying the container's egress failed"),
  });

//#endregion

//#region renewal

const renewals = new WeakMap<object, Callback<Record<string, never>>>();

/**
 * Schedule the next renewal of this object's grants; with no egress left,
 * cancel the one `previous` scheduled. Renewal shares the object's alarm
 * with `Alchemy.makeCallback` (an object that calls `storage.setAlarm`
 * directly must use callbacks instead); an object that never grants egress
 * never touches its alarm.
 */
const scheduleRenewal = (
  state: cf.DurableObjectState,
  previous: StoredEgress | undefined,
  next: StoredEgress,
) =>
  Effect.gen(function* () {
    const renewal = renewals.get(state);
    if (!renewal) return;
    if (next.egress.length === 0 && !previous?.egress.length) return;
    yield* (
      next.egress.length === 0
        ? renewal.cancel(RENEWAL_ID)
        : renewal.schedule(RENEWAL_ID, { after: Duration.millis(renewIn(next.ttl)), payload: {} })
    ).pipe(
      Effect.catchTag("CallbackError", (error) =>
        Effect.logWarning("scheduling the egress renewal failed", error),
      ),
    );
  });

/** @internal Cancel the renewal (the container stops; the stored egress stays). */
export const cancelRenewal = (state: cf.DurableObjectState, stored: StoredEgress | undefined) =>
  Effect.gen(function* () {
    const renewal = renewals.get(state);
    if (renewal && stored?.egress.length) yield* renewal.cancel(RENEWAL_ID).pipe(Effect.ignore);
  });

/**
 * Mint `next`'s grants, store it, apply its routes to the running container
 * and schedule the renewal. Fails (storing nothing) on a route conflict or a
 * refused egress.
 */
export const applyEgress = (
  state: cf.DurableObjectState,
  container: cf.Container,
  next: StoredEgress,
): Effect.Effect<void, EgressError | ContainerError, RuntimeContext> =>
  Effect.gen(function* () {
    const previous = yield* loadEgress(state);
    const routes = yield* routesOf(next);
    yield* saveEgress(state, next);
    const hosts = yield* applyRoutes(state, container, routes, next.hosts);
    const stored = { ...next, hosts };
    yield* saveEgress(state, stored);
    yield* markApplied(state, stored);
    yield* scheduleRenewal(state, previous, stored);
  });

/** Check `next` (mint its grants, find route conflicts) and store it, without applying it. */
export const storeEgress = (
  state: cf.DurableObjectState,
  next: StoredEgress,
): Effect.Effect<void, EgressError | ContainerError, RuntimeContext> =>
  Effect.andThen(routesOf(next), saveEgress(state, next));

/** Whether `next` is what this instance already applied, and its grants aren't due for renewal. */
export const isApplied = (state: object, next: StoredEgress) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const current = applied.get(state);
    return (
      current !== undefined &&
      now < current.renewAt &&
      current.key === canonicalJson({ ttl: next.ttl, egress: next.egress })
    );
  });

/** The renewal: re-mint and re-apply what's stored, while the container runs. */
const renew = (state: cf.DurableObjectState) =>
  Effect.gen(function* () {
    const stored = yield* loadEgress(state);
    const container = state.container;
    if (!stored || !container?.running) {
      applied.delete(state);
      return;
    }
    yield* applyEgress(state, container, stored);
  });

/**
 * @internal Install the renewal callback on a Durable Object that owns a
 * container, when its instance initializes. A container still running from
 * before this instance (the object was evicted or redeployed) gets what's
 * stored re-applied at once.
 */
export const installRenewal = (state: cf.DurableObjectState) =>
  onAlarmCallbacksReady(
    state,
    RENEWAL_CALLBACK,
    Effect.gen(function* () {
      const renewal = yield* makeCallback(RENEWAL_CALLBACK, () => renew(state), {
        retry: { delay: "5 seconds" },
      });
      renewals.set(state, renewal as Callback<Record<string, never>>);
      if (!state.container?.running) return;
      const stored = yield* loadEgress(state).pipe(Effect.orElseSucceed(() => undefined));
      if (stored && (stored.egress.length > 0 || stored.hosts.length > 0)) {
        yield* renewal
          .schedule(RENEWAL_ID, { after: Duration.zero, payload: {} })
          .pipe(
            Effect.catchTag("CallbackError", (e) =>
              Effect.logWarning("re-applying egress failed", e),
            ),
          );
      }
    }),
  );

//#endregion

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
