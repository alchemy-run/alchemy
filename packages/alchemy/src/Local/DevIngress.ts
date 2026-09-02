import * as Ingress from "@alchemy.run/cloudflare-runtime/core/proxy/Ingress";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { AlchemyContext, type DevIngressOptions } from "../AlchemyContext.ts";
import { FQN_SEPARATOR } from "../FQN.ts";
import {
  hostsAddCommand,
  hostsAppendCommand,
  isNativelyLocal,
  missingHosts,
  readHostsFile,
} from "./HostsFile.ts";
import { QuickTunnel } from "./QuickTunnel.ts";
import {
  RelayConnector,
  type RelayConnection,
} from "./Relay/RelayConnector.ts";

export type { DevIngressOptions } from "../AlchemyContext.ts";

/** Default dev domain: `*.localhost` resolves to the loopback everywhere. */
export const DEFAULT_DEV_DOMAIN = "localhost";
/**
 * Default ingress port. It is the historical default of the first worker's
 * own dev server, so `http://localhost:1337` keeps working for single-worker
 * projects (the ingress forwards a bare host to the only route) and becomes
 * a directory of resources for larger ones.
 */
export const DEFAULT_INGRESS_PORT = 1337;

/** What a local provider asks the ingress to expose. */
export interface ExposeInput {
  /** Fully-qualified resource name — the registry key. */
  readonly fqn: string;
  /** Resource type shown on the index page (`Cloudflare.Worker`). */
  readonly type: string;
  /** Where the ingress forwards requests for this host. */
  readonly upstream: URL | string;
  /**
   * Explicit subdomain (`api` → `api.<domain>`). Defaults to the resource's
   * FQN, kebab-cased and reversed (`Site/Api` → `api.site`).
   */
  readonly subdomain?: string;
  /**
   * Per-resource tunnel override: `true` opens a quick tunnel even without
   * `--tunnel`, `false` keeps the resource local under `--tunnel`.
   */
  readonly tunnel?: boolean;
}

/** The public surface the ingress gives a resource. */
export interface Exposure {
  /** The host routed to the resource (`api.localhost`). */
  readonly host: string;
  /** The primary URL: the tunnel URL when tunneled, else the local host URL. */
  readonly url: string;
  /** Every URL serving the resource, most public first. */
  readonly urls: string[];
  /** The `https://*.trycloudflare.com` URL, when a tunnel is open. */
  readonly tunnelUrl: string | undefined;
  /** The dev-relay URL (`https://<name>.<namespace>.<relay domain>`), when connected. */
  readonly relayUrl?: string;
}

/**
 * The `alchemy dev` front door: one shared host-routing proxy so every
 * locally served resource is reachable as `http://<name>.<domain>[:port]`
 * on a single port, optionally exposed to the internet through a Cloudflare
 * quick tunnel per host. Lives in the dev sidecar for the whole session;
 * local providers call {@link expose} when an instance starts (idempotent —
 * a restart just re-points the route) and {@link unexpose} on delete.
 *
 * Disabled (every call a no-op returning `undefined`) unless
 * `AlchemyContext.ingress` is set, which the `dev` command always does.
 */
export class DevIngress extends Context.Service<
  DevIngress,
  {
    readonly options: DevIngressOptions | undefined;
    /** Route `<subdomain>.<domain>` to `upstream`; returns the public surface. */
    readonly expose: (
      input: ExposeInput,
    ) => Effect.Effect<Exposure | undefined>;
    /** Drop the resource's route (and close its tunnel). */
    readonly unexpose: (fqn: string) => Effect.Effect<void>;
  }
>()("alchemy/Local/DevIngress") {}

/**
 * The default subdomain of a resource: each FQN segment kebab-cased
 * (`MyApi` → `my-api`), innermost first (`Site/Api` → `api.site`), so
 * sibling namespaces never collide and a top-level `Api` is simply `api`.
 */
export const subdomainFor = (fqn: string): string =>
  fqn
    .split(FQN_SEPARATOR)
    .map(kebab)
    .filter((segment) => segment !== "")
    .reverse()
    .join(".");

const kebab = (segment: string): string =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

/** `http://host` when the ingress answers on :80, else `http://host:port`. */
export const hostUrl = (host: string, port: number | undefined): string =>
  port === undefined || port === 80
    ? `http://${host}`
    : `http://${host}:${port}`;

/** Commands that forward a privileged port to the ingress, per platform. */
export const portForwardCommands = (
  from: number,
  to: number,
  platform: NodeJS.Platform = process.platform,
): string[] =>
  platform === "darwin"
    ? [
        `echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port ${from} -> 127.0.0.1 port ${to}" | sudo pfctl -ef -`,
      ]
    : platform === "linux"
      ? [
          `sudo iptables -t nat -A OUTPUT -o lo -p tcp --dport ${from} -j REDIRECT --to-port ${to}`,
        ]
      : [];

const disabled = DevIngress.of({
  options: undefined,
  expose: () => Effect.succeed(undefined),
  unexpose: () => Effect.void,
});

interface Registration {
  host: string;
  tunnel?: { url: URL; scope: Scope.Closeable };
}

/**
 * One ingress per `(domain, port)` per process. The layer is built once per
 * stack session (the sidecar serves many sessions — every scratch stack of
 * a test file, for one), but they all describe the same front door, so the
 * served instance and its route registry are shared process-wide and live
 * in a scope that is never closed (the ingress dies with the process).
 */
const instances = new Map<
  string,
  Effect.Effect<DevIngress["Service"], never>
>();

export const layer = Layer.effect(
  DevIngress,
  Effect.gen(function* () {
    const { ingress: options } = yield* AlchemyContext;
    if (options === undefined) return disabled;
    const key = `${options.domain}\u0000${options.port}\u0000${options.tunnel}`;
    const existing = instances.get(key);
    if (existing !== undefined) return yield* existing;
    // The runtime services of the FIRST session build the shared instance;
    // the ingress and tunnel manager are process-wide singletons themselves.
    const services = yield* Effect.context<
      Ingress.Ingress | QuickTunnel | RelayConnector
    >();
    const detached = yield* Scope.make();
    const instance = yield* Effect.cached(
      make(options).pipe(
        Effect.provideContext(services),
        Effect.orDie,
        Scope.provide(detached),
      ),
    );
    instances.set(key, instance);
    return yield* instance;
  }),
);

const make = Effect.fn("DevIngress.make")(function* (
  options: DevIngressOptions,
) {
  const ingress = yield* Ingress.Ingress;
  const tunnels = yield* QuickTunnel;
  const relays = yield* RelayConnector;
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const rootScope = yield* Effect.scope;

  // Serve eagerly, before any resource's own proxy claims a port, so the
  // ingress port is stable across runs regardless of start order. A
  // privileged port (`--port 80`) we can't bind falls back to the default
  // port; below we detect whether the OS forwards the privileged port to
  // us and, if not, tell the user how.
  let privilegedFallback = false;
  const served = yield* ingress
    .serve({ port: options.port, domain: options.domain })
    .pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "ConfigError" && error.subtag === "PrivilegedPort",
        () =>
          Effect.suspend(() => {
            privilegedFallback = true;
            return ingress.serve({
              port: DEFAULT_INGRESS_PORT,
              domain: options.domain,
            });
          }),
      ),
    );

  // The port to advertise in URLs: the served port, or none at all when
  // the requested privileged port forwards to this instance.
  let advertisePort: number | undefined = served.port;
  if (privilegedFallback) {
    const forwarded = yield* probeForward(options.port, served.id);
    if (forwarded) {
      advertisePort = options.port === 80 ? undefined : options.port;
    } else {
      const commands = portForwardCommands(options.port, served.port);
      yield* Effect.logWarning(
        [
          `Could not bind the dev ingress to port ${options.port} (it needs elevated privileges); serving on ${served.port} instead.`,
          ...(commands.length > 0
            ? [
                `To use http://<name>.${options.domain} without a port, forward ${options.port} to the ingress once (needs sudo):`,
                ...commands.map((c) => `  ${c}`),
              ]
            : []),
        ].join("\n"),
      );
    }
  }

  yield* Effect.logDebug(
    `Dev ingress serving ${served.url} (domain ${options.domain}${options.tunnel ? ", tunnels on" : ""})`,
  );

  // One relay connection for the whole session: the relay routes
  // `<label>.<namespace>.<domain>` down it, and the connector answers from
  // this ingress with the matching local host as the route hint. A relay
  // that can't be reached is a warning, not a dead dev session.
  const relay: RelayConnection | undefined = options.relay
    ? yield* relays
        .connect({
          ...options.relay,
          target: served.url,
          localHost: (label) => `${label}.${options.domain}`,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Could not connect to the dev relay at ${options.relay!.url}; serving locally only.\n${cause}`,
            ).pipe(Effect.as(undefined)),
          ),
        )
    : undefined;

  const registrations = new Map<string, Registration>();
  const hostOwners = new Map<string, string>();
  const warnedHosts = new Set<string>();
  const lock = Semaphore.makeUnsafe(1);

  const hostsFileCheck = (host: string) =>
    Effect.gen(function* () {
      if (isNativelyLocal(host) || warnedHosts.has(host) || Option.isNone(fs)) {
        return;
      }
      const content = yield* readHostsFile().pipe(
        Effect.provideService(FileSystem.FileSystem, fs.value),
        Effect.orElseSucceed(() => ""),
      );
      const missing = missingHosts(content, [host]);
      if (missing.length === 0) return;
      warnedHosts.add(host);
      yield* Effect.logWarning(
        [
          `${host} is not in your hosts file, so browsers and tools on this machine can't resolve it yet. Add it once (needs sudo):`,
          `  ${hostsAddCommand(missing)}`,
          `or, without the alchemy CLI on root's PATH:`,
          `  ${hostsAppendCommand(missing)}`,
        ].join("\n"),
      );
    });

  const resolveHost = (input: ExposeInput): string => {
    const existing = registrations.get(input.fqn);
    const preferred = `${input.subdomain ?? subdomainFor(input.fqn)}.${options.domain}`;
    if (existing && existing.host === preferred) return preferred;
    const owner = hostOwners.get(preferred);
    if (owner === undefined || owner === input.fqn) return preferred;
    // Two resources want the same label (an explicit `subdomain` clash,
    // or a kebab-case collision): the later one falls back to its full,
    // namespaced label.
    return `${subdomainFor(input.fqn)}.${options.domain}`;
  };

  const openTunnel = (fqn: string, host: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(rootScope);
      const opened = yield* tunnels
        .open({
          target: served.url,
          hostHeader: host,
          onOutput: (line) => Effect.logDebug(`[cloudflared ${host}] ${line}`),
        })
        .pipe(Scope.provide(scope));
      yield* Effect.logInfo(
        `[${fqn}] Tunnel → ${opened.url.toString().replace(/\/$/, "")} → http://${host} (the hostname can take ~30s to become reachable)`,
      );
      // A quick tunnel's hostname dies with its process; surface it so the
      // user knows the public URL went away (the next restart reopens one).
      yield* opened.exited.pipe(
        Effect.andThen(
          Effect.logWarning(
            `[${fqn}] Tunnel ${opened.url} closed (cloudflared exited). Restart the resource to open a new one.`,
          ),
        ),
        Effect.forkIn(scope),
      );
      return { url: opened.url, scope };
    });

  const expose = Effect.fn("DevIngress.expose")(function* (
    input: ExposeInput,
  ): Effect.fn.Return<Exposure | undefined> {
    const host = resolveHost(input);
    const previous = registrations.get(input.fqn);
    if (previous && previous.host !== host) {
      yield* served.unset(previous.host).pipe(Effect.ignore);
      hostOwners.delete(previous.host);
      if (previous.tunnel) {
        yield* Scope.close(previous.tunnel.scope, Exit.void);
        previous.tunnel = undefined;
      }
    }
    const registration: Registration = previous ?? { host };
    registration.host = host;
    registrations.set(input.fqn, registration);
    hostOwners.set(host, input.fqn);

    const wantTunnel = input.tunnel ?? options.tunnel;
    if (wantTunnel && registration.tunnel === undefined) {
      const tunnel = yield* openTunnel(input.fqn, host).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `[${input.fqn}] Could not open a quick tunnel for ${host}; serving locally only.\n${cause}`,
          ).pipe(Effect.as(undefined)),
        ),
      );
      registration.tunnel = tunnel;
    } else if (!wantTunnel && registration.tunnel !== undefined) {
      yield* Scope.close(registration.tunnel.scope, Exit.void);
      registration.tunnel = undefined;
    }

    const tunnelUrl = registration.tunnel?.url.toString().replace(/\/$/, "");
    const label = host.slice(0, -(options.domain.length + 1));
    const relayUrl = relay?.publicUrl(label);
    yield* served
      .set(host, {
        upstream: input.upstream.toString(),
        label: input.fqn.split(FQN_SEPARATOR).at(-1),
        fqn: input.fqn,
        type: input.type,
        tunnelUrl: tunnelUrl ?? relayUrl,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `[${input.fqn}] Could not register ${host} with the dev ingress.\n${cause}`,
          ),
        ),
      );
    yield* hostsFileCheck(host);

    const local = hostUrl(host, advertisePort);
    // Public first: the relay URL is stable, a quick tunnel's is not.
    const urls = [
      ...(relayUrl ? [relayUrl] : []),
      ...(tunnelUrl ? [tunnelUrl] : []),
      local,
    ];
    if (advertisePort === undefined && served.port !== 80) {
      // Forwarded privileged port: the served port still works too.
      urls.push(hostUrl(host, served.port));
    }
    return {
      host,
      url: urls[0]!,
      urls,
      tunnelUrl,
      relayUrl,
    } satisfies Exposure;
  }, lock.withPermits(1));

  const unexpose = Effect.fn("DevIngress.unexpose")(function* (
    fqn: string,
  ): Effect.fn.Return<void> {
    const registration = registrations.get(fqn);
    if (registration === undefined) return;
    registrations.delete(fqn);
    if (hostOwners.get(registration.host) === fqn) {
      hostOwners.delete(registration.host);
    }
    yield* served.unset(registration.host).pipe(Effect.ignore);
    if (registration.tunnel) {
      yield* Scope.close(registration.tunnel.scope, Exit.void);
    }
  }, lock.withPermits(1));

  return DevIngress.of({ options, expose, unexpose });
});

/** Whether `http://127.0.0.1:<port>` is forwarded to the ingress instance `id`. */
const probeForward = (port: number, id: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/cdn-cgi/ingress/health`,
      { signal },
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { id?: string };
    return body.id === id;
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => false),
  );

/**
 * {@link layer} with its runtime dependencies: the workerd-backed ingress
 * and the cloudflared tunnel manager. Needs `AlchemyContext` plus the
 * platform services (FileSystem, Path, HttpClient, ChildProcessSpawner).
 */
export const layerWithRuntime = () =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(Ingress.layer(), QuickTunnelLayer, RelayConnectorLayer),
    ),
  );

import { layer as QuickTunnelLayer } from "./QuickTunnel.ts";
import { layer as RelayConnectorLayer } from "./Relay/RelayConnector.ts";
