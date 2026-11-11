import { Credentials } from "@distilled.cloud/e2b/Credentials";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { E2BUnexpectedResponse } from "./Errors.ts";
import { declarable } from "./internal/Declared.ts";
import { hasOwnershipMetadata, ownershipMetadata, userMetadata } from "./internal/Ownership.ts";
import { denyUnlisted } from "./internal/SandboxHandle.ts";
import type { VolumeMount } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";

/**
 * A SOCKS5 proxy that carries a sandbox's outbound TCP. E2B applies the
 * allow and deny rules first, then tunnels what's left through the proxy;
 * code in the sandbox can't tell, and can't go around it. The proxy must
 * accept TCP connections, so a Cloudflare Worker can't be one.
 */
export interface SandboxEgressProxy {
  /** The proxy's address, as `host:port`. */
  address: string;
  /** SOCKS5 username. */
  username?: string;
  /** SOCKS5 password. E2B never returns it. */
  password?: string | Redacted.Redacted<string>;
  /**
   * Connect to the proxy over TLS, so the username and password aren't
   * sent in the clear.
   */
  tls?: {
    /** Whether to use TLS. */
    enabled: boolean;
    /** Name to check the proxy's certificate against. @default the host in `address` */
    serverName?: string;
    /** PEM certificates to trust instead of the system's, for a private CA. */
    caCert?: string;
  };
}

/** Egress rules for a declared sandbox, in E2B's shape. */
export interface SandboxNetwork {
  /**
   * Whether the sandbox's URLs accept requests without its traffic token.
   * Changing it replaces the sandbox.
   * @default true
   */
  allowPublicTraffic?: boolean;
  /**
   * The only destinations the sandbox may reach: CIDR blocks, IPs or
   * domains (`*.example.com`). Everything else is denied unless `denyOut`
   * says otherwise.
   */
  allowOut?: string[];
  /** Denied CIDR blocks or IPs. Domains are not supported. */
  denyOut?: string[];
  /** DNS servers the sandbox may reach when `allowOut` lists a domain. @default ["8.8.8.8"] */
  dnsServers?: string[];
  /**
   * Header rules for outbound HTTPS requests, by domain. Reference an
   * `E2B.Secret`'s `ref` here to inject it at egress.
   */
  rules?: sandboxes.SandboxNetworkConfigRulesMap;
  /**
   * Send the sandbox's outbound TCP through a SOCKS5 proxy you run: a
   * gateway that adds credentials, a static IP, or an audit log.
   */
  egressProxy?: SandboxEgressProxy;
  /**
   * The `Host` header requests to the sandbox's URLs arrive with, such as
   * `localhost:${PORT}`. Changing it replaces the sandbox.
   */
  maskRequestHost?: string;
  /**
   * Ports where the sandbox serves HTTPS itself. E2B connects to them over
   * TLS without checking the certificate. Changing them replaces the
   * sandbox.
   */
  httpsPorts?: number[];
}

/**
 * What a sandbox boots from: an `E2B.Template` or an `E2B.Snapshot`, declared
 * or yielded.
 */
export interface SandboxTemplate {
  templateId: string;
  /** A template's current build. A new build replaces the sandbox. */
  buildId?: string;
  /** A snapshot's setup hash. A new snapshot replaces the sandbox. */
  setupHash?: string;
  /** The volumes a template program mounts (`E2B.MountVolume`). */
  mounts?: VolumeMount[];
}

export interface SandboxProps {
  /**
   * The `E2B.Template` or `E2B.Snapshot` the sandbox boots from. Changing
   * it, or rebuilding it, replaces the sandbox so it boots the new build.
   */
  template: SandboxTemplate;
  /**
   * How long the sandbox runs after it starts or resumes before E2B pauses
   * it. Changing it applies to the current run (and resumes a paused
   * sandbox once to apply it).
   * @default "5 minutes"
   */
  timeout?: Duration.Input;
  /**
   * Resume the paused sandbox on the next request: to one of its URLs, or
   * a call into it from `E2B.ConnectSandbox`. Without it, calls into the
   * paused sandbox fail with `SandboxNotRunning` until `resume()`. Needs
   * `memory`. Changing it replaces the sandbox.
   * @default true
   */
  autoResume?: boolean;
  /**
   * Keep memory as well as the filesystem when the sandbox pauses, so it
   * resumes where it left off. `false` keeps only the filesystem and the
   * sandbox reboots on resume. Changing it replaces the sandbox.
   * @default true
   */
  memory?: boolean;
  /** Environment variables for the sandbox. Changing them replaces the sandbox. */
  env?: Record<string, string>;
  /** Your own metadata. Changing it replaces the sandbox. */
  metadata?: Record<string, string>;
  /**
   * Egress rules. `allowOut`, `denyOut`, `dnsServers`, `rules` and
   * `egressProxy` update in place; `allowPublicTraffic`, `maskRequestHost`
   * and `httpsPorts` replace the sandbox.
   */
  network?: SandboxNetwork;
  /**
   * Volumes to mount: `{ volume, path }`, where `volume` is an `E2B.Volume`.
   * A template program's own mounts are added. E2B attaches volumes only
   * when a sandbox is created, so changing them replaces the sandbox.
   */
  mounts?: VolumeMount[];
}

export interface SandboxAttributes {
  /** E2B's sandbox id. */
  sandboxId: string;
  /** The template id the sandbox booted from. */
  templateId: string;
  /** The template build (or snapshot) the sandbox booted. */
  templateBuild: string | undefined;
  /** The volumes mounted into the sandbox: its own and its template program's. */
  mounts: VolumeMount[];
  /**
   * The domain its ports are served under: port `p` answers at
   * `https://<p>-<sandboxId>.<domain>`.
   */
  domain: string;
  /**
   * The token requests to the sandbox's URLs send in the
   * `e2b-traffic-access-token` header when `allowPublicTraffic` is `false`.
   */
  trafficAccessToken: Redacted.Redacted<string> | undefined;
  /** Your metadata, without Alchemy's ownership stamp. */
  metadata: Record<string, string>;
  /** CPU cores. */
  cpuCount: number;
  /** Memory in MiB. */
  memoryMB: number;
}

export interface Sandbox extends Resource<
  "E2B.Sandbox",
  SandboxProps,
  SandboxAttributes,
  never,
  Providers,
  { sandboxId: string }
> {}

/**
 * An E2B sandbox the stack owns: one long-lived sandbox that pauses when it
 * is idle and resumes when it is used, instead of one per request.
 *
 * Use it for a workspace that outlives requests (an agent's home, a dev
 * box) or to serve a template program at a stable URL. The sandbox runs for
 * `timeout` after it starts or resumes, then E2B pauses it with its memory
 * and files. A request to one of its URLs resumes it (`autoResume`), and so
 * does `resume()` on `E2B.ConnectSandbox`.
 *
 * Alchemy stamps its stack, stage and logical ID into the sandbox's
 * metadata to recognise the sandboxes it owns.
 *
 * :::caution
 * Replacing the sandbox (a new or rebuilt `template`, or new `env`,
 * `metadata`, `mounts`, `memory`, `autoResume`, `allowPublicTraffic`,
 * `maskRequestHost` or `httpsPorts`) starts a
 * fresh sandbox and kills the old one with its files. If E2B no longer has
 * the sandbox, the next deploy that updates it (or `alchemy drift`) creates
 * a new one.
 * :::
 *
 * ### Creating a Sandbox
 * **Example:** A dev box from a template
 * ```typescript
 * import * as E2B from "@alchemy.run/e2b";
 * import * as Effect from "effect/Effect";
 *
 * export const Node = E2B.Template("Node", { image: "node:22" });
 *
 * export const DevBox = E2B.Sandbox("DevBox", {
 *   template: Node,
 *   timeout: "10 minutes",
 * });
 * ```
 *
 * ### Serving a template program
 * A template program starts when its sandbox boots. Declare one sandbox for
 * it: each new build of the program replaces the sandbox, so it always runs
 * the current one.
 *
 * **Example:** The program at a stable URL
 * ```typescript
 * import * as E2B from "@alchemy.run/e2b";
 * import * as Output from "alchemy/Output";
 * import * as Effect from "effect/Effect";
 * import Api from "./src/api.ts";
 *
 * export const ApiSandbox = Effect.gen(function* () {
 *   const sandbox = yield* E2B.Sandbox("Api", { template: Api });
 *   return { url: Output.interpolate`https://3000-${sandbox.sandboxId}.${sandbox.domain}` };
 * });
 * ```
 *
 * ### Private URLs
 * **Example:** Require the traffic token
 * ```typescript
 * const sandbox = yield* E2B.Sandbox("Private", {
 *   template: Node,
 *   network: { allowPublicTraffic: false },
 * });
 * // send sandbox.trafficAccessToken in the `e2b-traffic-access-token` header
 * ```
 *
 * ### Egress through your own proxy
 * E2B sends the sandbox's outbound TCP through a SOCKS5 proxy you run,
 * after its allow and deny rules. Code in the sandbox can't tell, and
 * can't go around it.
 *
 * **Example:** A proxy over TLS, with a password
 * ```typescript
 * import * as E2B from "@alchemy.run/e2b";
 * import * as Config from "effect/Config";
 * import { Node } from "./Node.ts";
 *
 * export const Proxied = E2B.Sandbox("Proxied", {
 *   template: Node,
 *   network: {
 *     egressProxy: {
 *       address: "proxy.example.com:1080",
 *       username: "sandbox",
 *       password: Config.Redacted("PROXY_PASSWORD"),
 *       tls: { enabled: true },
 *     },
 *   },
 * });
 * ```
 *
 * ### Using it at runtime
 * **Example:** Run a command in it from a Worker
 * ```typescript
 * const devBox = yield* E2B.ConnectSandbox(DevBox);
 * // in fetch:
 * yield* devBox.resume();
 * const result = yield* devBox.exec("git pull && npm test", { cwd: "/home/user/repo" });
 * ```
 *
 * ### Mounting volumes
 * **Example:** A shared cache volume
 * ```typescript
 * export const Cache = E2B.Volume("Cache", {});
 *
 * export const Builder = E2B.Sandbox("Builder", {
 *   template: Node,
 *   mounts: [{ volume: Cache, path: "/cache" }],
 * });
 * ```
 *
 * ### Referencing a sandbox the stack doesn't manage
 * **Example:** Look one up by id
 * ```typescript
 * const shared = E2B.Sandbox.lookup({ sandboxId: "i1a2b3c4d5e6f7g8h9" });
 * const box = yield* E2B.ConnectSandbox(shared);
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const Sandbox = declarable<Sandbox>()(Resource<Sandbox>("E2B.Sandbox"));

const DEFAULT_TIMEOUT_SECONDS = 300;

const secondsOf = (timeout: Duration.Input | undefined) =>
  timeout === undefined
    ? DEFAULT_TIMEOUT_SECONDS
    : Math.max(1, Math.round(Duration.toMillis(Duration.fromInputUnsafe(timeout)) / 1000));

const redact = (token: string | Redacted.Redacted<string> | null | undefined) =>
  token === undefined || token === null
    ? undefined
    : Redacted.isRedacted(token)
      ? token
      : Redacted.make(token);

/** The E2B domain the credentials address; sandboxes on it report no domain of their own. */
const configuredDomain = Effect.gen(function* () {
  const credentials = yield* Credentials;
  return (yield* credentials).domain;
});

/** A sandbox's details, or `undefined` when E2B no longer has it. */
const observeSandbox = (sandboxId: string) =>
  sandboxes.getSandbox({ sandboxID: sandboxId }).pipe(
    Effect.map((detail): sandboxes.SandboxDetail | undefined => detail),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

interface Stored {
  readonly templateBuild: string | undefined;
  readonly trafficAccessToken: Redacted.Redacted<string> | undefined;
  readonly mounts: VolumeMount[];
}

const toAttributes = (
  detail: sandboxes.SandboxDetail,
  stored: Stored,
  fallbackDomain: string,
): SandboxAttributes => ({
  sandboxId: detail.sandboxID,
  templateId: detail.templateID,
  templateBuild: stored.templateBuild,
  mounts: stored.mounts,
  domain: detail.domain ?? fallbackDomain,
  trafficAccessToken: stored.trafficAccessToken,
  metadata: userMetadata(detail.metadata as Record<string, string>),
  cpuCount: detail.cpuCount,
  memoryMB: detail.memoryMB,
});

/** The network fields `updateSandboxNetwork` can change, as E2B stores them. */
const mutableNetwork = (network: SandboxNetwork | sandboxes.SandboxNetworkConfig | undefined) => {
  const desired = network === undefined ? {} : denyUnlisted(network);
  return {
    allowOut: [...(desired.allowOut ?? [])].sort(),
    denyOut: [...(desired.denyOut ?? [])].sort(),
    dnsServers: desired.dnsServers === undefined ? undefined : [...desired.dnsServers].sort(),
    rules: desired.rules ?? {},
    egressProxy: proxyIdentity(desired.egressProxy),
  };
};

const plain = (value: string | Redacted.Redacted<string> | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** An egress proxy without its password, which E2B never returns. */
const proxyIdentity = (
  proxy: SandboxEgressProxy | sandboxes.SandboxEgressProxyConfig | null | undefined,
) =>
  proxy === undefined || proxy === null
    ? undefined
    : {
        address: proxy.address,
        username: proxy.username ?? undefined,
        tls: proxy.tls?.enabled
          ? {
              serverName: proxy.tls.serverName ?? undefined,
              caCert: proxy.tls.caCert ?? undefined,
            }
          : undefined,
      };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The template's mounts and the sandbox's own, by path (the sandbox's win). */
const mountsOf = (props: SandboxProps): VolumeMount[] =>
  [
    ...new Map(
      [...(props.template.mounts ?? []), ...(props.mounts ?? [])].map(
        (mount) => [mount.path, { volume: { name: mount.volume.name }, path: mount.path }] as const,
      ),
    ).values(),
  ].sort((a, b) => a.path.localeCompare(b.path));

const templateBuildOf = (props: SandboxProps) => props.template.buildId ?? props.template.setupHash;

/** Props whose change means a new sandbox (E2B can't change them on a live one). */
const replacingProps = (props: SandboxProps) => ({
  template: props.template.templateId,
  build: templateBuildOf(props),
  autoResume: props.autoResume ?? true,
  memory: props.memory ?? true,
  env: props.env ?? {},
  metadata: props.metadata ?? {},
  mounts: mountsOf(props),
  allowPublicTraffic: props.network?.allowPublicTraffic ?? true,
  maskRequestHost: props.network?.maskRequestHost,
  httpsPorts: [...(props.network?.httpsPorts ?? [])].sort((a, b) => a - b),
});

export const SandboxProvider = () =>
  Provider.effect(
    Sandbox,
    Effect.gen(function* () {
      return {
        stables: ["sandboxId", "templateId", "domain"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (!sameJson(replacingProps(olds), replacingProps(news))) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (output === undefined) return undefined;
          const detail = yield* observeSandbox(output.sandboxId);
          if (detail === undefined) return undefined;
          const attrs = toAttributes(detail, output, yield* configuredDomain);
          const ours = yield* hasOwnershipMetadata(id, detail.metadata as Record<string, string>);
          return ours ? attrs : Unowned(attrs);
        }),
        lookup: Effect.fn(function* ({ sandboxId }) {
          const detail = yield* observeSandbox(sandboxId);
          if (detail === undefined) return undefined;
          return toAttributes(
            detail,
            { templateBuild: undefined, trafficAccessToken: undefined, mounts: [] },
            yield* configuredDomain,
          );
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const timeout = secondsOf(news.timeout);
          const memory = news.memory ?? true;
          const autoResume = news.autoResume ?? true;
          const mounts = mountsOf(news);
          const templateBuild = templateBuildOf(news);

          // Observe — `output` caches the id; the sandbox may be gone.
          let detail = output === undefined ? undefined : yield* observeSandbox(output.sandboxId);
          let trafficAccessToken = output?.trafficAccessToken;

          // Ensure
          if (detail === undefined) {
            yield* session.note(`Creating sandbox from ${news.template.templateId}...`);
            const created = yield* sandboxes.createSandbox({
              templateID: news.template.templateId,
              timeout,
              autoPause: true,
              autoPauseMemory: memory,
              autoResume: { enabled: autoResume },
              metadata: { ...news.metadata, ...(yield* ownershipMetadata(id)) },
              ...(news.env === undefined ? {} : { envVars: news.env }),
              ...(news.network === undefined ? {} : { network: denyUnlisted(news.network) }),
              ...(mounts.length === 0
                ? {}
                : {
                    volumeMounts: mounts.map((mount) => ({
                      name: mount.volume.name,
                      path: mount.path,
                    })),
                  }),
            });
            trafficAccessToken = redact(created.trafficAccessToken);
            detail = yield* observeSandbox(created.sandboxID);
            if (detail === undefined) {
              return yield* new E2BUnexpectedResponse({
                message: `E2B sandbox ${created.sandboxID} vanished after create`,
              });
            }
            return toAttributes(
              detail,
              { templateBuild, trafficAccessToken, mounts },
              created.domain ?? (yield* configuredDomain),
            );
          }

          // Sync — egress rules, observed against what E2B stores.
          const desiredNetwork = mutableNetwork(news.network);
          const observedNetwork = mutableNetwork(detail.network);
          const dnsMatches =
            desiredNetwork.dnsServers === undefined ||
            sameJson(desiredNetwork.dnsServers, observedNetwork.dnsServers);
          if (
            !sameJson(desiredNetwork.allowOut, observedNetwork.allowOut) ||
            !sameJson(desiredNetwork.denyOut, observedNetwork.denyOut) ||
            !sameJson(desiredNetwork.rules, observedNetwork.rules) ||
            !sameJson(desiredNetwork.egressProxy, observedNetwork.egressProxy) ||
            // The proxy's password can't be observed, so `olds` is the only
            // signal it changed.
            (olds !== undefined &&
              plain(olds.network?.egressProxy?.password) !==
                plain(news.network?.egressProxy?.password)) ||
            !dnsMatches
          ) {
            yield* session.note(`Updating sandbox ${detail.sandboxID} network...`);
            yield* sandboxes.updateSandboxNetwork({
              sandboxID: detail.sandboxID,
              allowOut: desiredNetwork.allowOut,
              denyOut: desiredNetwork.denyOut,
              rules: desiredNetwork.rules,
              // An update replaces the whole configuration: a field left
              // out is cleared.
              ...(news.network?.egressProxy === undefined
                ? {}
                : { egressProxy: news.network.egressProxy }),
              ...(desiredNetwork.dnsServers === undefined
                ? {}
                : { dnsServers: desiredNetwork.dnsServers }),
            });
          }

          // Sync — the run's timeout. E2B doesn't report the configured
          // timeout, so `olds` is the only signal it changed.
          if (olds !== undefined && secondsOf(olds.timeout) !== timeout) {
            if (detail.state === "paused") {
              // Resuming takes the new timeout; the sandbox pauses again after it.
              const resumed = yield* sandboxes.connectSandbox({
                sandboxID: detail.sandboxID,
                timeout,
              });
              trafficAccessToken = redact(resumed.trafficAccessToken) ?? trafficAccessToken;
            } else {
              yield* sandboxes.setSandboxTimeout({ sandboxID: detail.sandboxID, timeout });
            }
          }

          return toAttributes(
            detail,
            { templateBuild, trafficAccessToken, mounts },
            yield* configuredDomain,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* sandboxes
            .deleteSandbox({ sandboxID: output.sandboxId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const domain = yield* configuredDomain;
          const all = Array.from(
            yield* Stream.runCollect(
              sandboxes.listSandboxes.items({
                state: ["running", "paused"],
                limit: 100,
              }),
            ),
          );
          return (
            all
              // Declared sandboxes and the ones bindings create at run time
              // both carry `alchemy::stack`, so `nuke` finds both.
              .filter((sandbox) => sandbox.metadata?.["alchemy::stack"] !== undefined)
              .map((sandbox): SandboxAttributes => ({
                sandboxId: sandbox.sandboxID,
                templateId: sandbox.templateID,
                templateBuild: undefined,
                mounts: (sandbox.volumeMounts ?? []).map((mount) => ({
                  volume: { name: mount.name },
                  path: mount.path,
                })),
                domain,
                trafficAccessToken: undefined,
                metadata: userMetadata(sandbox.metadata as Record<string, string>),
                cpuCount: sandbox.cpuCount,
                memoryMB: sandbox.memoryMB,
              }))
          );
        }),
      };
    }),
  );
