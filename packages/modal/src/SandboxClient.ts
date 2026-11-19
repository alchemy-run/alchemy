import * as persistent from "@distilled.cloud/modal/persistent";
import * as sandbox from "@distilled.cloud/modal/sandbox";
import * as router from "@distilled.cloud/modal/task_command_router";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { buildImage, gpuConfig, ImageBuildOps, type ImageBuildSpec } from "./ImageBuild.ts";
import { environmentOf, type ErrorOf, operations, seconds } from "./internal.ts";
import { connectTcp } from "./internal/TcpConnect.ts";
import { streamRouter, withRouter } from "./ModalBindings.ts";
import { type ModalMounts, modalMountsOf, type SandboxMount } from "./Mounts.ts";

/** A sandbox ended (or never became ready) before the call could finish. */
export class SandboxNotRunning extends Data.TaggedError("Modal.SandboxNotRunning")<{
  readonly sandboxId: string;
  readonly message: string;
}> {}

/** A Modal call returned without the field the client needs. */
export class SandboxUnexpectedResponse extends Data.TaggedError("Modal.SandboxUnexpectedResponse")<{
  readonly message: string;
}> {}

/** A filesystem operation inside the sandbox failed (missing path, permissions). */
export class SandboxFilesystemError extends Data.TaggedError("Modal.SandboxFilesystemError")<{
  readonly path: string;
  readonly message: string;
}> {}

/** A Modal duration: seconds, or a string like `"10 minutes"`. */
export type DurationInput = number | string;

/** An image a sandbox boots from: a registry ref, or a `Modal.Image` (resolved). */
export type SandboxImage = string | { readonly imageId: string };

/** Where a route sends matching traffic: blocked, through a `Modal.Proxy`, or to a sidecar. */
export type OutboundRedirect =
  | "block"
  | { readonly proxy: { readonly proxyId: string } }
  | { readonly sidecar: string };

/** An inclusive port range, or one port. */
export type OutboundPorts = ReadonlyArray<
  number | { readonly start: number; readonly end: number }
>;

/** Set headers on decrypted HTTPS requests, with values from a secret. */
export interface HeaderReplacement {
  /** The secret whose keys the header values reference. Omit for static values. */
  readonly secret?: { readonly secretId: string };
  /** Header name to value; `$KEY` is replaced with the secret's `KEY`, `$$` is a literal `$`. */
  readonly headers: Record<string, string>;
}

/**
 * One route of an {@link OutboundPolicy}. Routes match in order; traffic a
 * route matches without a `redirect` goes to its destination.
 */
export type OutboundRoute =
  | {
      /** Traffic to these CIDR ranges. */
      readonly ip: {
        readonly cidrs: ReadonlyArray<string>;
        /** @default every port */
        readonly ports?: OutboundPorts;
        readonly transport?: "tcp" | "udp" | "any";
        readonly redirect?: OutboundRedirect;
      };
    }
  | {
      /** TLS connections to these domains (`*.` wildcards allowed), never decrypted. */
      readonly tls: {
        readonly domains: ReadonlyArray<string>;
        /** @default 443 */
        readonly ports?: OutboundPorts;
        readonly redirect?: OutboundRedirect;
      };
    }
  | {
      /** HTTPS requests to these domains, decrypted so headers can be replaced. */
      readonly https: {
        readonly domains: ReadonlyArray<string>;
        /** @default 443 */
        readonly ports?: OutboundPorts;
        readonly headerReplacements?: ReadonlyArray<HeaderReplacement>;
        readonly redirect?: OutboundRedirect;
      };
    }
  | {
      /** Everything no earlier route matched. Must be the last route. */
      readonly any: { readonly redirect?: OutboundRedirect };
    };

/**
 * A sandbox's outbound traffic rules, enforced by Modal outside the
 * sandbox. HTTPS routes decrypt traffic with a certificate authority the
 * sandbox trusts, so Modal can add credentials the sandbox never sees.
 */
export interface OutboundPolicy {
  readonly routes: ReadonlyArray<OutboundRoute>;
  /**
   * Let HTTPS routes decrypt traffic. Fixed at creation.
   * @default true when a route is `https`
   */
  readonly tlsDecryption?: boolean;
}

/** Options for creating a sandbox: Modal's own sandbox parameters. */
export interface SandboxCreateOptions {
  /** Image to boot. Defaults to the binding's image, else `debian:bookworm-slim`. */
  readonly image?: SandboxImage;
  /**
   * The sandbox's main process. Without one the sandbox idles (`sleep`) and
   * you drive it with {@link SandboxHandle.exec}.
   */
  readonly command?: ReadonlyArray<string>;
  /** Working directory of the main process and of exec'd commands. */
  readonly workdir?: string;
  /** Environment variables for the main process. */
  readonly env?: Record<string, string>;
  /** Secrets whose variables the sandbox sees as environment variables. */
  readonly secrets?: ReadonlyArray<{ readonly secretId: string }>;
  /**
   * Volumes and cloud buckets to mount: volume handles, bucket names, or
   * the references `Modal.MountVolume` / `Modal.MountBucket` return.
   */
  readonly mounts?: ReadonlyArray<SandboxMount>;
  /** CPU cores (fractional allowed). */
  readonly cpu?: number;
  /** Memory in MiB. */
  readonly memory?: number;
  /** GPU: `"T4"`, `"A10G"`, `"A100-80GB"`, `"H100"`, with an optional `":<count>"`. */
  readonly gpu?: string;
  /** Ephemeral disk in MiB. */
  readonly ephemeralDisk?: number;
  /** Most time the sandbox lives. @default 5 minutes (Modal's default); at most 24 hours */
  readonly timeout?: DurationInput;
  /** Terminate after this long without exec'd commands or connections. */
  readonly idleTimeout?: DurationInput;
  /** Name, unique among the app's running sandboxes; find it again with `fromName`. */
  readonly name?: string;
  /** Tags, for `list({ tags })`. */
  readonly tags?: Record<string, string>;
  /** Regions to run in (`"us-east"`, `"eu"`, ...). */
  readonly regions?: ReadonlyArray<string>;
  /** Block all network access. */
  readonly blockNetwork?: boolean;
  /** Allow outbound traffic only to these CIDR ranges (and {@link allowedDomains}). */
  readonly cidrAllowlist?: ReadonlyArray<string>;
  /** Allow outbound traffic only to these domains (and {@link cidrAllowlist}). */
  readonly allowedDomains?: ReadonlyArray<string>;
  /** Allow inbound connections (tunnels) only from these CIDR ranges. */
  readonly inboundCidrAllowlist?: ReadonlyArray<string>;
  /** Outbound header injection: secrets the sandbox never sees. */
  readonly outboundPolicy?: OutboundPolicy;
  /** Route outbound traffic through a `Modal.Proxy`'s static IPs. */
  readonly proxy?: { readonly proxyId: string };
  /**
   * Give the sandbox a `MODAL_IDENTITY_TOKEN` environment variable: an OIDC
   * token Modal signs, naming the workspace, environment, app and sandbox.
   * A cloud that trusts Modal's issuer (`https://oidc.modal.com`) exchanges
   * it for short-lived credentials, so no long-lived key enters the sandbox.
   */
  readonly includeOidcIdentityToken?: boolean;
  /**
   * Serve the sandbox an X.509 certificate that names it (an X.509-SVID),
   * over the SPIFFE Workload API socket at `SPIFFE_ENDPOINT_SOCKET`. A
   * cloud that trusts Modal's certificate authority (AWS IAM Roles
   * Anywhere) exchanges it for short-lived credentials.
   */
  readonly includeX509Svid?: boolean;
  /** Ports reachable through TLS tunnels (`sandbox.getTcpPort(port)`). */
  readonly encryptedPorts?: ReadonlyArray<number>;
  /** Ports reachable through plain TCP tunnels. */
  readonly unencryptedPorts?: ReadonlyArray<number>;
  /** Ports reachable through HTTP/2 tunnels. */
  readonly h2Ports?: ReadonlyArray<number>;
  /** Allow memory snapshots of this sandbox (`snapshotMemory`). */
  readonly enableSnapshot?: boolean;
  /** Serve tunnels on a custom domain registered with Modal. */
  readonly customDomain?: string;
}

/** What a finished command printed, and its exit code. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A command: a shell string (run with `sh -c`), or an argument vector (no shell). */
export type Command = Sandbox.Command;

/** Options for {@link SandboxHandleOf.exec}. */
export interface ExecOptions {
  /** Working directory. @default the sandbox's `workdir` */
  readonly cwd?: string;
  /** Extra environment variables for this command. */
  readonly env?: Record<string, string>;
  /** Secrets whose variables this command sees. */
  readonly secrets?: ReadonlyArray<{ readonly secretId: string }>;
  /** Kill the command after this long. */
  readonly timeout?: DurationInput;
  /** Bytes (or text) written to the command's stdin, then closed. */
  readonly stdin?: string | Uint8Array;
}

/** A filesystem entry inside a sandbox. */
export interface SandboxFileEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

/** What `files.stat` reports about a path. */
export interface SandboxFileStat extends SandboxFileEntry {
  /** Size in bytes. */
  readonly size: number;
  /** Last modification time. */
  readonly modifiedAt: DateTime.Utc;
}

/** A tunnel to a port inside the sandbox. */
export interface SandboxTunnel {
  /** `https://…` (or `tcp://…` for unencrypted tunnels). */
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

/** The error of one of {@link SandboxOps}. */
export type SandboxOpError<K extends keyof SandboxOps> = ErrorOf<SandboxOps[K]>;
type RouterOpError<K extends keyof typeof routerOps> =
  Effect.Success<ReturnType<(typeof routerOps)[K]>> extends (...args: any[]) => infer Out
    ? Out extends Effect.Effect<any, infer E, any>
      ? E
      : Out extends Stream.Stream<any, infer E, any>
        ? E
        : never
    : never;

/** Reaching a sandbox's task: it ended, or Modal's task lookup failed. */
export type SandboxTaskError =
  | SandboxNotRunning
  | SandboxUnexpectedResponse
  | SandboxOpError<"getTaskId">
  | SandboxOpError<"getCommandRouterAccess">;

/** Running a command in a sandbox. */
export type SandboxExecError =
  | SandboxTaskError
  | RouterOpError<"execStart" | "execStdinWrite" | "execStdioRead" | "execWait">;

/** A started process: running it, following its output, writing its stdin, signalling it. */
export type SandboxProcessError = SandboxExecError | RouterOpError<"execStdioFollow">;

/** Modal's task command router has no call to resize a running PTY. */
export class SandboxPtyResizeUnsupported extends Data.TaggedError(
  "Modal.SandboxPtyResizeUnsupported",
)<{
  readonly message: string;
}> {}

/** A terminal session's errors. */
export type SandboxPtyError = SandboxProcessError | SandboxPtyResizeUnsupported;

/** Options for `pty.open`: the terminal size, and what runs in it. */
export interface SandboxPtyOptions extends Sandbox.PtyOptions {
  /** Secrets whose variables the session sees. */
  readonly secrets?: ReadonlyArray<{ readonly secretId: string }>;
}

/** A file operation inside a sandbox (it runs as a command). */
export type SandboxFilesError = SandboxExecError | SandboxFilesystemError;

/** Taking a snapshot or changing a running sandbox through its command router. */
export type SandboxRouterError<K extends keyof typeof routerOps> =
  | SandboxTaskError
  | RouterOpError<K>;

/** The files inside a sandbox, read and written with commands its image has (`sh`, `base64`, `stat`). */
export interface SandboxFilesOf<R> {
  /** Read a file. */
  read(path: string): Effect.Effect<Uint8Array, SandboxFilesError, R>;
  /** Read a UTF-8 file. */
  readText(path: string): Effect.Effect<string, SandboxFilesError, R>;
  /** Write (create or truncate) a file, creating its directory. */
  write(path: string, data: string | Uint8Array): Effect.Effect<void, SandboxFilesError, R>;
  /** List a directory. */
  list(path: string): Effect.Effect<ReadonlyArray<SandboxFileEntry>, SandboxFilesError, R>;
  /** A path's type, size and modification time. */
  stat(path: string): Effect.Effect<SandboxFileStat, SandboxFilesError, R>;
  /** Remove a file, or a directory with `recursive`. */
  remove(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<void, SandboxFilesError, R>;
  /** Create a directory and its parents. */
  makeDir(path: string): Effect.Effect<void, SandboxFilesError, R>;
}

/** A running (or finished) Modal sandbox. Every method calls Modal's API. */
export interface SandboxHandleOf<R> {
  readonly sandboxId: string;
  /**
   * Run a command and wait for it. A string runs with `sh -c`; an argument
   * vector runs without a shell. A non-zero exit code is returned, not failed.
   */
  exec(command: Command, options?: ExecOptions): Effect.Effect<ExecResult, SandboxExecError, R>;
  /**
   * Start a command and follow it: its output streams as it runs, `write`
   * feeds its stdin, `kill` signals it. Closing the scope detaches; the
   * command keeps running.
   */
  start(
    command: Command,
    options?: ExecOptions,
  ): Effect.Effect<Sandbox.Process<SandboxProcessError>, SandboxProcessError, R | Scope.Scope>;
  /**
   * Terminals: `open` starts a login shell (or `command`) on a PTY of the
   * given size. Modal can't resize a running PTY, so `resize` fails with
   * {@link SandboxPtyResizeUnsupported}.
   */
  readonly pty: Sandbox.Pty<SandboxPtyError, SandboxPtyOptions>;
  /** The sandbox's files. */
  readonly files: SandboxFilesOf<R>;
  /** Tunnels to the sandbox's open ports, by container port. */
  tunnels(
    timeout?: DurationInput,
  ): Effect.Effect<Record<number, SandboxTunnel>, SandboxOpError<"getTunnels">, R>;
  /**
   * A token-authenticated URL for one port, for a browser or client that
   * shouldn't hold Modal credentials.
   */
  connectToken(options?: {
    readonly port?: number;
    readonly userMetadata?: string;
  }): Effect.Effect<
    { readonly url: string; readonly token: string },
    SandboxOpError<"createConnectToken"> | SandboxUnexpectedResponse,
    R
  >;
  /** Capture the filesystem as a new image (usable as `image` later). */
  snapshotFilesystem(
    timeout?: DurationInput,
  ): Effect.Effect<{ readonly imageId: string }, SandboxRouterError<"snapshotFilesystem">, R>;
  /** Capture memory and filesystem (needs `enableSnapshot`); restore with `restore`. */
  snapshotMemory(): Effect.Effect<
    { readonly snapshotId: string },
    SandboxRouterError<"snapshotMemory">,
    R
  >;
  /** Capture one directory as an image (mount it into another sandbox with `mountDirectory`). */
  snapshotDirectory(
    path: string,
  ): Effect.Effect<{ readonly imageId: string }, SandboxRouterError<"snapshotDirectory">, R>;
  /** Mount a directory snapshot at `path`. */
  mountDirectory(
    path: string,
    snapshot: { readonly imageId: string },
  ): Effect.Effect<void, SandboxRouterError<"mountDirectory">, R>;
  /**
   * Replace the sandbox's outbound network policy while it runs. Connections
   * the new policy no longer allows are closed. `{}` opens the network.
   */
  setNetworkAccess(access: {
    readonly blockNetwork?: boolean;
    readonly cidrAllowlist?: ReadonlyArray<string>;
    readonly allowedDomains?: ReadonlyArray<string>;
  }): Effect.Effect<void, SandboxRouterError<"setNetworkAccess">, R>;
  /** Replace the outbound header injection rules while it runs. */
  setOutboundPolicy(
    policy: OutboundPolicy,
  ): Effect.Effect<void, SandboxOpError<"setOutboundPolicy">, R>;
  /** Replace the sandbox's tags. */
  setTags(tags: Record<string, string>): Effect.Effect<void, SandboxOpError<"setTags">, R>;
  /** The sandbox's tags. */
  getTags(): Effect.Effect<Record<string, string>, SandboxOpError<"getTags">, R>;
  /** Name the sandbox (unique among its app's running sandboxes) so `fromName` finds it. */
  setName(name: string): Effect.Effect<void, SandboxOpError<"setName">, R>;
  /** CPU, memory and GPU used so far (core-seconds, GiB-seconds, GPU-seconds). */
  resourceUsage(): Effect.Effect<
    { readonly cpuSeconds: number; readonly memoryGibSeconds: number; readonly gpuSeconds: number },
    SandboxOpError<"getResourceUsage">,
    R
  >;
  /**
   * The main process's stdout so far: what the sandbox's command router sends
   * within `timeout` (default 5 seconds), or all of it once the program has
   * exited.
   */
  logs(options?: {
    readonly timeout?: DurationInput;
  }): Effect.Effect<string, SandboxRouterError<"mainStdio">, R>;
  /** Wait for the sandbox to finish; `undefined` exit code while still running. */
  wait(
    timeout?: DurationInput,
  ): Effect.Effect<
    { readonly exitCode?: number; readonly status: string },
    SandboxOpError<"wait">,
    R
  >;
  /** Terminate the sandbox (no-op when it already finished). */
  terminate(): Effect.Effect<
    void,
    Exclude<SandboxOpError<"terminate">, { readonly _tag: "SandboxNotFound" }>,
    R
  >;
  /**
   * A port inside the sandbox, reached through its tunnel: `fetch` sends a
   * client request there, or proxies a server request a handler received;
   * `connect` opens a TCP socket to it. The port needs a tunnel
   * (`encryptedPorts`, `unencryptedPorts` or `h2Ports`); without a port
   * number, the `Modal.Sandbox` program's.
   */
  getTcpPort(port?: number): Effect.Effect<SandboxPortOf<R>, SandboxPortError, R>;
}

/** Looking up a sandbox port's tunnel. */
export type SandboxPortError = SandboxOpError<"getTunnels"> | SandboxUnexpectedResponse;

/**
 * A port inside a sandbox, with the tunnel Modal opened to it. `fetch` keeps
 * the request's method, path, query, headers and body, and sends it to the
 * tunnel; given the server request a handler received, it proxies it and
 * returns the server response.
 */
export interface SandboxPortOf<R> extends SandboxTunnel {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    SandboxPortError | HttpClientError.HttpClientError,
    R
  >;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    SandboxPortError | HttpClientError.HttpClientError,
    R
  >;
  /**
   * A TCP socket to the port through its tunnel: TLS for an encrypted tunnel
   * (`encryptedPorts`), plain TCP for an unencrypted one (`unencryptedPorts`).
   * It connects when run.
   */
  connect(): Effect.Effect<Socket.Socket>;
}

/** A sandbox port as bindings return it. */
export type SandboxPort = SandboxPortOf<RuntimeContext>;

/**
 * A sandbox handle as bindings return it: calls run inside a deployed
 * runtime. It has the shared `alchemy/Sandbox` shape plus Modal's own calls.
 */
export interface SandboxHandle
  extends
    SandboxHandleOf<RuntimeContext>,
    Sandbox.SandboxExec<SandboxExecError, ExecResult, ExecOptions>,
    Sandbox.SandboxProcesses<SandboxProcessError, ExecOptions>,
    Sandbox.SandboxFiles<SandboxFilesError, SandboxFileEntry>,
    Sandbox.SandboxPty<SandboxPtyError, SandboxPtyOptions>,
    Sandbox.SandboxPorts<SandboxPortError, SandboxPort> {
  readonly files: SandboxFilesOf<RuntimeContext>;
  getTcpPort(port?: number): Effect.Effect<SandboxPort, SandboxPortError, RuntimeContext>;
}

/** A sandbox handle whose calls need Modal credentials and an HTTP client. */
export type RawSandboxHandle = SandboxHandleOf<never>;

/** Where a sandbox client creates sandboxes. */
export interface SandboxTarget {
  readonly appId: string;
  /** Environment of the app (for name lookups and tag updates). */
  readonly environment?: string;
  /** Name of the app (for name lookups). */
  readonly appName?: string;
  /** Image used when `create` names none. */
  readonly imageId?: string;
  /** A `Modal.Sandbox` program: the secret holding its env, its command, its port and mounts. */
  readonly program?: {
    readonly secretId: string;
    readonly command: ReadonlyArray<string>;
    readonly port: number;
    readonly mounts?: ModalMounts;
  };
}

/** The text of a command's output stream, from its router read chunks. */
const streamText = (chunks: ReadonlyArray<{ readonly data?: string }>) =>
  Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data ?? "", "base64"))).toString("utf8");

const decodeBase64 = (data: string) =>
  Effect.sync(() => new Uint8Array(Buffer.from(data, "base64")));
const encodeBase64 = (data: string | Uint8Array) =>
  Effect.sync(() =>
    typeof data === "string"
      ? Buffer.from(data, "utf8").toString("base64")
      : Buffer.from(data).toString("base64"),
  );

const tunnelTypeOf = (h2: boolean): sandbox.TunnelType | undefined =>
  h2 ? "TUNNEL_TYPE_H2" : undefined;

/** Modal's `Sandbox` definition for {@link SandboxCreateOptions}. */
const definitionOf = (
  imageId: string,
  options: SandboxCreateOptions,
  mounts: ModalMounts,
): sandbox.Sandbox => ({
  imageId,
  entrypointArgs: options.command ? [...options.command] : ["sleep", "infinity"],
  workdir: options.workdir,
  environmentVariables: options.env,
  secretIds: options.secrets?.map((s) => s.secretId),
  volumeMounts: mounts.volumeMounts,
  cloudBucketMounts: mounts.cloudBucketMounts,
  resources: {
    milliCpu: options.cpu !== undefined ? Math.round(options.cpu * 1000) : undefined,
    memoryMb: options.memory,
    gpuConfig: gpuConfig(options.gpu),
    ephemeralDiskMb: options.ephemeralDisk,
  },
  timeoutSecs: seconds(options.timeout),
  idleTimeoutSecs: seconds(options.idleTimeout),
  name: options.name,
  schedulerPlacement: options.regions ? { regions: [...options.regions] } : undefined,
  blockNetwork: options.blockNetwork,
  networkAccess: networkAccessOf(options),
  inboundCidrAllowlist: options.inboundCidrAllowlist
    ? [...options.inboundCidrAllowlist]
    : undefined,
  outboundPolicy: options.outboundPolicy ? outboundPolicyOf(options.outboundPolicy) : undefined,
  proxyId: options.proxy?.proxyId,
  includeOidcIdentityToken: options.includeOidcIdentityToken,
  includeX509Svid: options.includeX509Svid,
  openPorts: {
    ports: [
      ...(options.encryptedPorts ?? []).map((port) => ({ port })),
      ...(options.unencryptedPorts ?? []).map((port) => ({ port, unencrypted: true })),
      ...(options.h2Ports ?? []).map((port) => ({ port, tunnelType: tunnelTypeOf(true) })),
    ],
  },
  enableSnapshot: options.enableSnapshot,
  customDomain: options.customDomain,
});

const networkAccessOf = (options: {
  readonly blockNetwork?: boolean;
  readonly cidrAllowlist?: ReadonlyArray<string>;
  readonly allowedDomains?: ReadonlyArray<string>;
}): sandbox.NetworkAccess | undefined =>
  options.blockNetwork
    ? { networkAccessType: "BLOCKED" }
    : options.cidrAllowlist !== undefined || options.allowedDomains !== undefined
      ? {
          networkAccessType: "ALLOWLIST",
          allowedCidrs: options.cidrAllowlist ? [...options.cidrAllowlist] : [],
          allowedDomains: options.allowedDomains ? [...options.allowedDomains] : [],
        }
      : undefined;

/**
 * The policy for a sandbox that is already running. Modal's task router
 * accepts only an allow-list here: an empty one blocks everything, and
 * `0.0.0.0/0` opens the network.
 */
const runningNetworkAccessOf = (access: {
  readonly blockNetwork?: boolean;
  readonly cidrAllowlist?: ReadonlyArray<string>;
  readonly allowedDomains?: ReadonlyArray<string>;
}): sandbox.NetworkAccess => {
  const open = access.cidrAllowlist === undefined && access.allowedDomains === undefined;
  return {
    networkAccessType: "ALLOWLIST",
    allowedCidrs: access.blockNetwork
      ? []
      : open
        ? ["0.0.0.0/0"]
        : [...(access.cidrAllowlist ?? [])],
    allowedDomains: access.blockNetwork ? [] : [...(access.allowedDomains ?? [])],
  };
};

const portsOf = (ports: OutboundPorts | undefined) =>
  ports?.map((port) => (typeof port === "number" ? { start: port, end: port } : port));

const transportOf = (transport: "tcp" | "udp" | "any" | undefined) =>
  transport === undefined ? undefined : (`TRANSPORT_${transport.toUpperCase()}` as const);

const redirectOf = (
  redirect: OutboundRedirect | undefined,
): sandbox.OutboundPolicyRedirect | undefined =>
  redirect === undefined
    ? undefined
    : redirect === "block"
      ? { block: {} }
      : "proxy" in redirect
        ? { viaProxy: { proxyId: redirect.proxy.proxyId } }
        : { viaSidecar: { sidecarName: redirect.sidecar } };

const outboundPolicyOf = (policy: OutboundPolicy): sandbox.OutboundPolicy => ({
  tlsDecryption: {
    allowed: policy.tlsDecryption ?? policy.routes.some((route) => "https" in route),
  },
  routes: policy.routes.map((route): sandbox.OutboundPolicyRoute => {
    if ("ip" in route) {
      return {
        ip: {
          cidrs: [...route.ip.cidrs],
          ports: portsOf(route.ip.ports),
          transport: transportOf(route.ip.transport),
          redirect: redirectOf(route.ip.redirect),
        },
      };
    }
    if ("tls" in route) {
      return {
        tls: {
          domains: [...route.tls.domains],
          ports: portsOf(route.tls.ports),
          redirect: redirectOf(route.tls.redirect),
        },
      };
    }
    if ("https" in route) {
      return {
        https: {
          domains: [...route.https.domains],
          ports: portsOf(route.https.ports),
          headerReplacements: route.https.headerReplacements?.map((r) => ({
            secretId: r.secret?.secretId,
            headers: r.headers,
          })),
          redirect: redirectOf(route.https.redirect),
        },
      };
    }
    return { any: { redirect: redirectOf(route.any.redirect) } };
  }),
});

/**
 * The operations sandbox clients call, resolved once by
 * `ModalBindings.withCredentials` (or at deploy, with the deployer's).
 */
export const SandboxOps = operations({
  create: sandbox.sandboxCreateV2,
  getFromName: sandbox.sandboxGetFromNameV2,
  list: sandbox.sandboxListV2,
  restore: sandbox.sandboxRestoreV2,
  getTaskId: sandbox.sandboxGetTaskIdV2,
  getCommandRouterAccess: sandbox.sandboxGetCommandRouterAccess,
  getTunnels: sandbox.sandboxGetTunnelsV2,
  createConnectToken: sandbox.sandboxCreateConnectTokenV2,
  setOutboundPolicy: sandbox.sandboxSetOutboundPolicyV2,
  setTags: sandbox.sandboxTagsSetV2,
  getTags: sandbox.sandboxTagsGetV2,
  setName: sandbox.sandboxSetName,
  getResourceUsage: sandbox.sandboxGetResourceUsage,
  wait: sandbox.sandboxWaitV2,
  terminate: sandbox.sandboxTerminateV2,
  usage: sandbox.sandboxGetTimeRangeStats,
  createPersistent: persistent.createPersistentSandbox,
  getPersistent: persistent.getPersistentSandbox,
  resumePersistent: persistent.resumePersistentSandbox,
  terminatePersistent: persistent.terminatePersistentSandbox,
  images: ImageBuildOps,
  http: HttpClient.HttpClient,
});

export type SandboxOps = Effect.Success<typeof SandboxOps>;

/** Task command router operations, resolved per sandbox with its router access. */
const routerOps = {
  execStart: withRouter(router.taskExecStart),
  execStdinWrite: withRouter(router.taskExecStdinWrite),
  execStdioRead: withRouter(router.taskExecStdioRead),
  execWait: withRouter(router.taskExecWait),
  // A running command's output, each chunk as the router sends it; the
  // stream ends when the command closes the descriptor.
  execStdioFollow: streamRouter(router.taskExecStdioRead),
  snapshotFilesystem: withRouter(router.taskSnapshotFilesystem),
  snapshotMemory: withRouter(router.taskSnapshotMemory),
  snapshotDirectory: withRouter(router.taskSnapshotDirectory),
  mountDirectory: withRouter(router.taskMountDirectory),
  setNetworkAccess: withRouter(router.taskSetNetworkAccess),
  // The sandbox's own program's output (V2 sandboxes serve it here, not
  // through the control plane's sandboxGetLogs).
  mainStdio: streamRouter(router.sandboxStdioReadV2),
};

/**
 * The image to boot: a `Modal.Image`'s id, or a registry ref built (and
 * cached by Modal) into an image in the target app.
 */
export const resolveSandboxImage = Effect.fn(function* (
  ops: SandboxOps,
  target: SandboxTarget,
  image: SandboxImage | undefined,
) {
  if (image !== undefined && typeof image !== "string") return image.imageId;
  if (image === undefined && target.imageId !== undefined) return target.imageId;
  const spec: ImageBuildSpec = { dockerTag: image ?? "debian:bookworm-slim", commands: [] };
  return yield* buildImage(ops.images, target.appId, spec);
});

/** The handle for an existing sandbox id. */
export const sandboxHandle = (
  ops: SandboxOps,
  sandboxId: string,
  target: Pick<SandboxTarget, "environment" | "program">,
): RawSandboxHandle => {
  let cachedTaskId: string | undefined;
  const taskId = Effect.gen(function* () {
    if (cachedTaskId !== undefined) return cachedTaskId;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = yield* ops.getTaskId({
        sandboxId,
        timeout: 55,
        waitUntilReady: true,
      });
      if (response.taskId) {
        cachedTaskId = response.taskId;
        return response.taskId;
      }
      if (
        response.taskResult?.status &&
        response.taskResult.status !== "GENERIC_STATUS_UNSPECIFIED"
      ) {
        return yield* new SandboxNotRunning({
          sandboxId,
          message: `Sandbox ${sandboxId} finished with ${response.taskResult.status}`,
        });
      }
    }
    return yield* new SandboxNotRunning({
      sandboxId,
      message: `Sandbox ${sandboxId} wasn't scheduled within 9 minutes`,
    });
  });

  const viaRouter = <Op, A, E>(
    resolve: (access: { readonly url: string; readonly jwt: string }) => Effect.Effect<Op>,
    f: (op: Op, taskId: string) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const id = yield* taskId;
      const access = yield* ops.getCommandRouterAccess({ taskId: id });
      if (!access.url || !access.jwt) {
        return yield* new SandboxUnexpectedResponse({
          message: `Modal returned no command router for sandbox ${sandboxId}`,
        });
      }
      const op = yield* resolve({ url: access.url, jwt: access.jwt });
      return yield* f(op, id);
    });

  /**
   * Run a filesystem command with `sh` (every image Modal boots has one) and
   * fail with {@link SandboxFilesystemError} on a non-zero exit.
   */
  const fsExec = (path: string, script: string, stdin?: string | Uint8Array) =>
    Effect.flatMap(
      exec(["sh", "-c", script, "sh", path], stdin === undefined ? {} : { stdin }),
      (result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new SandboxFilesystemError({
                path,
                message: result.stderr.trim() || `exit code ${result.exitCode}`,
              }),
            ),
    );

  const exec = Effect.fn(function* (command: Command, options: ExecOptions = {}) {
    // V2 sandboxes run commands through the task command router: start the
    // command under an id we choose, then read its output streams while
    // waiting for it to exit.
    const id = yield* taskId;
    const access = yield* ops.getCommandRouterAccess({ taskId: id });
    if (!access.url || !access.jwt) {
      return yield* new SandboxUnexpectedResponse({
        message: `Modal returned no command router for sandbox ${sandboxId}`,
      });
    }
    const at = { url: access.url, jwt: access.jwt };
    const start = yield* routerOps.execStart(at);
    const stdinWrite = yield* routerOps.execStdinWrite(at);
    const stdioRead = yield* routerOps.execStdioRead(at);
    const wait = yield* routerOps.execWait(at);
    const execId = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe());
    yield* start({
      taskId: id,
      execId,
      commandArgs: typeof command === "string" ? ["sh", "-c", command] : [...command],
      workdir: options.cwd,
      timeoutSecs: seconds(options.timeout),
      secretIds: options.secrets?.map((s) => s.secretId),
      env: options.env,
      stdoutConfig: "TASK_EXEC_STDOUT_CONFIG_PIPE",
      stderrConfig: "TASK_EXEC_STDERR_CONFIG_PIPE",
    });
    if (options.stdin !== undefined) {
      yield* stdinWrite({
        taskId: id,
        execId,
        offset: "0",
        data: yield* encodeBase64(options.stdin),
        eof: true,
      });
    }
    const read = (fileDescriptor: router.TaskExecStdioFileDescriptor) =>
      stdioRead({ taskId: id, execId, offset: "0", fileDescriptor }).pipe(
        Effect.map(({ items }) => streamText(items)),
      );
    const [stdout, stderr, exit] = yield* Effect.all(
      [
        read("TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDOUT"),
        read("TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDERR"),
        wait({ taskId: id, execId }),
      ],
      { concurrency: "unbounded" },
    );
    return {
      exitCode: exit.code ?? (exit.signal !== undefined ? 128 + exit.signal : -1),
      stdout,
      stderr,
    };
  });

  /** The task and its router access, for the router calls of one command. */
  const routerAccess = Effect.gen(function* () {
    const id = yield* taskId;
    const access = yield* ops.getCommandRouterAccess({ taskId: id });
    if (!access.url || !access.jwt) {
      return yield* new SandboxUnexpectedResponse({
        message: `Modal returned no command router for sandbox ${sandboxId}`,
      });
    }
    return { taskId: id, at: { url: access.url, jwt: access.jwt } };
  });

  /**
   * Start a command (on a PTY with `pty`) and return how to follow it: a
   * stream per output, stdin writes from a running offset, and its exit.
   */
  const startExec = Effect.fn(function* (
    commandArgs: ReadonlyArray<string>,
    options: ExecOptions,
    pty?: router.PTYInfo,
  ) {
    const { taskId: id, at } = yield* routerAccess;
    const begin = yield* routerOps.execStart(at);
    const stdinWrite = yield* routerOps.execStdinWrite(at);
    const follow = yield* routerOps.execStdioFollow(at);
    const wait = yield* routerOps.execWait(at);
    const execId = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe());
    yield* begin({
      taskId: id,
      execId,
      commandArgs: [...commandArgs],
      workdir: options.cwd,
      timeoutSecs: seconds(options.timeout),
      secretIds: options.secrets?.map((s) => s.secretId),
      env: options.env,
      stdoutConfig: "TASK_EXEC_STDOUT_CONFIG_PIPE",
      stderrConfig: pty ? undefined : "TASK_EXEC_STDERR_CONFIG_PIPE",
      ptyInfo: pty,
    });
    let stdinOffset = 0;
    const write = (data: string | Uint8Array, eof = false) =>
      Effect.gen(function* () {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const offset = stdinOffset;
        stdinOffset += bytes.length;
        yield* stdinWrite({
          taskId: id,
          execId,
          offset: String(offset),
          data: yield* encodeBase64(bytes),
          eof,
        });
      });
    /** One output of the command, each chunk as it arrives. */
    const output = (fileDescriptor: router.TaskExecStdioFileDescriptor) =>
      follow({ taskId: id, execId, offset: "0", fileDescriptor }).pipe(
        Stream.map((item) => new Uint8Array(Buffer.from(item.data, "base64"))),
        Stream.filter((bytes) => bytes.length > 0),
      );
    if (options.stdin !== undefined) yield* write(options.stdin, true);
    return {
      execId,
      write,
      output,
      wait: Effect.map(wait({ taskId: id, execId }), (exit) => ({
        exitCode: exit.code ?? (exit.signal !== undefined ? 128 + exit.signal : -1),
      })),
    };
  });

  const argvOf = (command: Command): ReadonlyArray<string> =>
    typeof command === "string" ? ["sh", "-c", command] : command;

  const start = (command: Command, options: ExecOptions = {}) =>
    Effect.gen(function* () {
      // The router has no signal call: the command records its pid, and
      // `kill` signals it with a second command.
      const pidFile = `/tmp/.alchemy-exec-${yield* Effect.sync(() => SecureRandom.uuidV4Unsafe())}.pid`;
      const running = yield* startExec(
        ["sh", "-c", 'echo $$ > "$0"; exec "$@"', pidFile, ...argvOf(command)],
        options,
      );
      return {
        id: running.execId,
        output: Stream.merge(
          Stream.map(running.output("TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDOUT"), (data) => ({
            fd: "stdout" as const,
            data,
          })),
          Stream.map(running.output("TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDERR"), (data) => ({
            fd: "stderr" as const,
            data,
          })),
        ),
        write: (data: string | Uint8Array) => running.write(data),
        kill: (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") =>
          Effect.asVoid(exec(["sh", "-c", `kill -s ${signal.slice(3)} "$(cat "$0")"`, pidFile])),
        wait: running.wait,
      } satisfies Sandbox.Process<SandboxProcessError>;
    });

  const pty: Sandbox.Pty<SandboxPtyError, SandboxPtyOptions> = {
    open: (options) =>
      Effect.gen(function* () {
        const running = yield* startExec(
          options.command
            ? ["sh", "-c", options.command]
            : ["sh", "-c", "exec bash -l 2>/dev/null || exec sh -l"],
          { cwd: options.cwd, env: options.env, secrets: options.secrets },
          {
            enabled: true,
            winszRows: options.rows,
            winszCols: options.cols,
            envTerm: "xterm-256color",
            ptyType: "PTY_TYPE_SHELL",
            noTerminateOnIdleStdin: true,
          },
        );
        return {
          id: running.execId,
          output: running.output("TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDOUT"),
          write: (data: string | Uint8Array) => running.write(data),
          resize: () =>
            Effect.fail(
              new SandboxPtyResizeUnsupported({
                message: "Modal's task command router can't resize a running PTY",
              }),
            ),
        } satisfies Sandbox.PtyConnection<SandboxPtyError>;
      }),
  };

  const read = Effect.fn(function* (path: string) {
    // base64 keeps binary content intact through the text output stream.
    const encoded = yield* fsExec(path, 'base64 < "$1" | tr -d "\\n"');
    return yield* decodeBase64(encoded);
  });

  const typeOf = (letter: string): SandboxFileEntry["type"] =>
    letter === "d" ? "directory" : letter === "l" ? "symlink" : letter === "f" ? "file" : "other";

  const files: SandboxFilesOf<never> = {
    read,
    readText: (path) => read(path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
    write: Effect.fn(function* (path, data) {
      const encoded = yield* encodeBase64(data);
      yield* fsExec(path, 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', encoded);
    }),
    list: Effect.fn(function* (path) {
      const output = yield* fsExec(
        path,
        'cd "$1" && for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -L "$f" ]; then echo "l $f"; elif [ -d "$f" ]; then echo "d $f"; elif [ -f "$f" ]; then echo "f $f"; else echo "o $f"; fi; done',
      );
      return output
        .split("\n")
        .filter((line) => line.length > 2)
        .map((line) => ({
          path: `${path.replace(/\/$/, "")}/${line.slice(2)}`,
          type: typeOf(line[0]!),
        }));
    }),
    stat: Effect.fn(function* (path) {
      // `%F` is GNU stat's type name; busybox prints the same names.
      const output = yield* fsExec(path, 'stat -c "%F|%s|%Y" "$1"');
      const [kind = "", size = "0", mtime = "0"] = output.trim().split("|");
      return {
        path,
        type: kind.includes("directory")
          ? "directory"
          : kind.includes("symbolic link")
            ? "symlink"
            : kind.includes("regular")
              ? "file"
              : "other",
        size: Number(size),
        modifiedAt: DateTime.makeUnsafe(Number(mtime) * 1000),
      } satisfies SandboxFileStat;
    }),
    remove: Effect.fn(function* (path, options = {}) {
      yield* fsExec(path, options.recursive ? 'rm -r "$1"' : 'rm "$1"');
    }),
    makeDir: Effect.fn(function* (path) {
      yield* fsExec(path, 'mkdir -p "$1"');
    }),
  };

  const tunnelsOf = Effect.fn(function* (timeout?: DurationInput) {
    const { tunnels } = yield* ops.getTunnels({
      sandboxId,
      timeout: seconds(timeout) ?? 50,
    });
    const out: Record<number, SandboxTunnel> = {};
    for (const tunnel of tunnels ?? []) {
      if (tunnel.containerPort === undefined) continue;
      const encrypted = tunnel.host !== undefined && tunnel.host !== "";
      const host = (encrypted ? tunnel.host : tunnel.unencryptedHost) ?? "";
      const port = (encrypted ? tunnel.port : tunnel.unencryptedPort) ?? 443;
      out[tunnel.containerPort] = {
        host,
        port,
        url: encrypted
          ? `https://${host}${port === 443 ? "" : `:${port}`}`
          : `tcp://${host}:${port}`,
      };
    }
    return out;
  });

  const getTcpPort = Effect.fn(function* (port: number | undefined = target.program?.port) {
    if (port === undefined) {
      return yield* new SandboxUnexpectedResponse({
        message: "getTcpPort needs a port: create the sandbox from a Modal.Sandbox, or pass one",
      });
    }
    const tunnel = (yield* tunnelsOf(50))[port];
    if (!tunnel) {
      return yield* new SandboxUnexpectedResponse({
        message: `Port ${port} of sandbox ${sandboxId} has no tunnel; open it with encryptedPorts`,
      });
    }
    const tls = tunnel.url.startsWith("https:");
    // An unencrypted tunnel carries plain TCP, so HTTP to it is cleartext.
    const origin = tls ? tunnel.url : `http://${tunnel.host}:${tunnel.port}`;
    const sandboxPort: SandboxPortOf<never> = {
      ...tunnel,
      // The user's own program, reached through its tunnel (allowed raw HTTP).
      fetch: Sandbox.portFetch((request) => {
        const url = new URL(request.url, "http://sandbox");
        // The tunnel routes by host, so a proxied request's own `host` goes.
        return ops.http.execute(
          HttpClientRequest.setUrl(
            HttpClientRequest.removeHeader(request, "host"),
            `${origin}${url.pathname}${url.search}`,
          ),
        );
      }) as SandboxPortOf<never>["fetch"],
      connect: () => connectTcp({ host: tunnel.host, port: tunnel.port, tls }),
    };
    return sandboxPort;
  });

  const handle: RawSandboxHandle = {
    sandboxId,
    exec,
    start,
    pty,
    files,
    tunnels: tunnelsOf,
    connectToken: Effect.fn(function* (options = {}) {
      const response = yield* ops.createConnectToken({
        sandboxId,
        port: options.port,
        userMetadata: options.userMetadata,
      });
      if (!response.url || !response.token) {
        return yield* new SandboxUnexpectedResponse({ message: "Modal returned no connect token" });
      }
      return { url: response.url, token: response.token };
    }),
    snapshotFilesystem: (_timeout) =>
      viaRouter(routerOps.snapshotFilesystem, (op, task) =>
        Effect.flatMap(
          Effect.sync(() => SecureRandom.uuidV4Unsafe()),
          // -1: the snapshot image never expires.
          (snapshotId) => op({ taskId: task, snapshotId, ttlSeconds: "-1" }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.imageId
            ? Effect.succeed({ imageId: response.imageId })
            : Effect.fail(
                new SandboxUnexpectedResponse({
                  message: `Filesystem snapshot of ${sandboxId} returned no image`,
                }),
              ),
        ),
      ),
    snapshotMemory: () =>
      viaRouter(routerOps.snapshotMemory, (op, task) =>
        Effect.flatMap(
          Effect.sync(() => SecureRandom.uuidV4Unsafe()),
          (idempotencyKey) => op({ taskId: task, idempotencyKey }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.snapshotId
            ? Effect.succeed({ snapshotId: response.snapshotId })
            : Effect.fail(new SandboxUnexpectedResponse({ message: "No snapshot id" })),
        ),
      ),
    snapshotDirectory: (path) =>
      viaRouter(routerOps.snapshotDirectory, (op, task) => op({ taskId: task, path })).pipe(
        Effect.flatMap((response) =>
          response.imageId
            ? Effect.succeed({ imageId: response.imageId })
            : Effect.fail(new SandboxUnexpectedResponse({ message: `No image for ${path}` })),
        ),
      ),
    mountDirectory: (path, snapshot) =>
      viaRouter(routerOps.mountDirectory, (op, task) =>
        op({ taskId: task, path, imageId: snapshot.imageId }),
      ).pipe(Effect.asVoid),
    setNetworkAccess: (access) =>
      viaRouter(routerOps.setNetworkAccess, (op, task) =>
        op({ taskId: task, networkAccess: runningNetworkAccessOf(access) }),
      ).pipe(Effect.asVoid),
    setOutboundPolicy: Effect.fn(function* (policy) {
      yield* ops.setOutboundPolicy({
        sandboxId,
        outboundPolicy: outboundPolicyOf(policy),
      });
    }),
    setTags: Effect.fn(function* (tags) {
      yield* ops.setTags({
        sandboxId,
        environmentName: environmentOf(target.environment),
        tags: Object.entries(tags).map(([tagName, tagValue]) => ({ tagName, tagValue })),
      });
    }),
    getTags: Effect.fn(function* () {
      const { tags } = yield* ops.getTags({ sandboxId });
      return Object.fromEntries((tags ?? []).map((t) => [t.tagName ?? "", t.tagValue ?? ""]));
    }),
    setName: Effect.fn(function* (name) {
      yield* ops.setName({ sandboxId, name });
    }),
    resourceUsage: Effect.fn(function* () {
      const usage = yield* ops.getResourceUsage({ sandboxId });
      return {
        cpuSeconds: Number(usage.cpuCoreNanosecs ?? 0) / 1e9,
        memoryGibSeconds: Number(usage.memGibNanosecs ?? 0) / 1e9,
        gpuSeconds: Number(usage.gpuNanosecs ?? 0) / 1e9,
      };
    }),
    logs: Effect.fn(function* (options = {}) {
      const { taskId: id, at } = yield* routerAccess;
      const read = yield* routerOps.mainStdio(at);
      const chunks = yield* read({
        taskId: id,
        offset: "0",
        fileDescriptor: "SANDBOX_STDIO_FILE_DESCRIPTOR_STDOUT",
      }).pipe(
        Stream.map((item) => Buffer.from(item.data, "base64")),
        Stream.interruptWhen(Effect.sleep(`${seconds(options.timeout) ?? 5} seconds`)),
        Stream.runCollect,
      );
      return Buffer.concat(chunks).toString("utf8");
    }),
    wait: Effect.fn(function* (timeout) {
      const { result } = yield* ops.wait({
        sandboxId,
        timeout: seconds(timeout) ?? 0,
      });
      return {
        exitCode: result?.exitcode,
        status: result?.status ?? "GENERIC_STATUS_UNSPECIFIED",
      };
    }),
    getTcpPort,
    terminate: Effect.fn(function* () {
      yield* ops
        .terminate({ sandboxId })
        .pipe(Effect.catchTag("SandboxNotFound", () => Effect.void));
    }),
  };
  return handle;
};

/**
 * Create a sandbox in `target`'s app and return its handle. The one
 * implementation behind `CreateSandbox` and warm-base image builds.
 */
export const createSandbox = Effect.fn(function* (
  ops: SandboxOps,
  target: SandboxTarget,
  options: SandboxCreateOptions = {},
) {
  const imageId = yield* resolveSandboxImage(ops, target, options.image);
  const program = target.program;
  const withProgram: SandboxCreateOptions = program
    ? {
        ...options,
        command: options.command ?? program.command,
        secrets: [{ secretId: program.secretId }, ...(options.secrets ?? [])],
        encryptedPorts: [...new Set([program.port, ...(options.encryptedPorts ?? [])])],
      }
    : options;
  const own = yield* modalMountsOf(options.mounts);
  const mounts: ModalMounts = {
    volumeMounts: [...(program?.mounts?.volumeMounts ?? []), ...own.volumeMounts],
    cloudBucketMounts: [...(program?.mounts?.cloudBucketMounts ?? []), ...own.cloudBucketMounts],
  };
  const created = yield* ops.create({
    appId: target.appId,
    definition: definitionOf(imageId, withProgram, mounts),
    tags: Object.entries(options.tags ?? {}).map(([tagName, tagValue]) => ({ tagName, tagValue })),
  });
  if (!created.sandboxId) {
    return yield* new SandboxUnexpectedResponse({ message: "Modal returned no sandbox id" });
  }
  return sandboxHandle(ops, created.sandboxId, target);
});

/** A running sandbox of `target`'s app by name, or `undefined`. */
export const sandboxFromName = Effect.fn(function* (
  ops: SandboxOps,
  target: SandboxTarget,
  name: string,
) {
  const found = yield* ops
    .getFromName({
      sandboxName: name,
      appName: target.appName,
      environmentName: environmentOf(target.environment),
    })
    .pipe(Effect.catchTag("SandboxNotFound", () => Effect.undefined));
  return found?.sandboxId ? sandboxHandle(ops, found.sandboxId, target) : undefined;
});

/** Running sandboxes of `target`'s app, optionally filtered by tags. */
export const listSandboxes = Effect.fn(function* (
  ops: SandboxOps,
  target: SandboxTarget,
  options: { readonly tags?: Record<string, string>; readonly includeFinished?: boolean } = {},
) {
  const { sandboxes } = yield* ops.list({
    appId: target.appId,
    environmentName: environmentOf(target.environment),
    includeFinished: options.includeFinished ?? false,
    tags: Object.entries(options.tags ?? {}).map(([tagName, tagValue]) => ({ tagName, tagValue })),
  });
  return (sandboxes ?? []).flatMap((info) =>
    info.id
      ? [
          {
            sandboxId: info.id,
            name: info.name || undefined,
            createdAt: info.createdAt,
            tags: Object.fromEntries(
              (info.tags ?? []).map((t) => [t.tagName ?? "", t.tagValue ?? ""]),
            ),
          },
        ]
      : [],
  );
});

/** Restore a memory snapshot into a new sandbox. */
export const restoreSandbox = Effect.fn(function* (
  ops: SandboxOps,
  target: SandboxTarget,
  snapshot: { readonly snapshotId: string },
  options: { readonly name?: string } = {},
) {
  const restored = yield* ops.restore({
    snapshotId: snapshot.snapshotId,
    sandboxNameOverride: options.name,
    sandboxNameOverrideType: options.name ? "SANDBOX_NAME_OVERRIDE_TYPE_STRING" : undefined,
  });
  if (!restored.sandboxId) {
    return yield* new SandboxUnexpectedResponse({ message: "Modal returned no restored sandbox" });
  }
  return sandboxHandle(ops, restored.sandboxId, target);
});

/**
 * Options for a persistent sandbox. Modal fixes each session's lifetime (an
 * hour, paused after five idle minutes) and doesn't support names, GPUs,
 * `env`, tags or memory snapshots on persistent sandboxes yet.
 */
export type PersistentSandboxCreateOptions = Omit<
  SandboxCreateOptions,
  "timeout" | "idleTimeout" | "name" | "gpu" | "env" | "tags" | "enableSnapshot"
>;

/** Modal's session limits for persistent sandboxes. */
const PERSISTENT_SESSION = { timeout: 60 * 60, idleTimeout: 5 * 60 } as const;

/** A persistent sandbox: one box whose filesystem outlives its sessions. */
export interface PersistentSandboxHandleOf<R> {
  readonly persistentSandboxId: string;
  /**
   * The running session, resuming the box from its last session's
   * filesystem when it's paused.
   */
  session(): Effect.Effect<
    SandboxHandleOf<R>,
    | SandboxOpError<"getPersistent">
    | SandboxOpError<"resumePersistent">
    | SandboxUnexpectedResponse,
    R
  >;
  /** Terminate the box for good. */
  terminate(): Effect.Effect<
    void,
    Exclude<SandboxOpError<"terminatePersistent">, { readonly _tag: "PersistentSandboxNotFound" }>,
    R
  >;
}

export type RawPersistentSandboxHandle = PersistentSandboxHandleOf<never>;
export type PersistentSandboxHandle = PersistentSandboxHandleOf<RuntimeContext>;

/** The handle for an existing persistent sandbox id. */
export const persistentSandboxHandle = (
  ops: SandboxOps,
  persistentSandboxId: string,
  target: Pick<SandboxTarget, "environment" | "program">,
): RawPersistentSandboxHandle => ({
  persistentSandboxId,
  session: Effect.fn(function* () {
    const running = yield* ops.getPersistent({ persistentSandboxId });
    if (running.sandboxId) return sandboxHandle(ops, running.sandboxId, target);
    // A paused box resumes from its last session's filesystem. Modal answers
    // busy while the previous session is still saving it.
    const resumed = yield* ops.resumePersistent({ persistentSandboxId }).pipe(
      Effect.retry({
        while: (error) => error._tag === "PersistentSandboxBusy",
        schedule: Schedule.spaced("1 second"),
        times: 60,
      }),
    );
    if (!resumed.sandboxId) {
      return yield* new SandboxUnexpectedResponse({
        message: `Modal returned no session for persistent sandbox ${persistentSandboxId}`,
      });
    }
    return sandboxHandle(ops, resumed.sandboxId, target);
  }),
  terminate: Effect.fn(function* () {
    yield* ops
      .terminatePersistent({ persistentSandboxId })
      .pipe(Effect.catchTag("PersistentSandboxNotFound", () => Effect.void));
  }),
});

/** Create a persistent sandbox in `target`'s app. */
export const createPersistentSandbox = Effect.fn(function* (
  ops: SandboxOps,
  target: SandboxTarget,
  options: PersistentSandboxCreateOptions = {},
) {
  const imageId = yield* resolveSandboxImage(ops, target, options.image);
  const created = yield* ops.createPersistent({
    appId: target.appId,
    definition: definitionOf(
      imageId,
      { ...options, ...PERSISTENT_SESSION },
      yield* modalMountsOf(options.mounts),
    ),
  });
  if (!created.persistentSandboxId) {
    return yield* new SandboxUnexpectedResponse({
      message: "Modal returned no persistent sandbox id",
    });
  }
  return persistentSandboxHandle(ops, created.persistentSandboxId, target);
});
