import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { deepEqual, isResolved } from "alchemy/Diff";
import type { MountCapability } from "alchemy/Mount";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding, LookupMethod } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { Stack } from "alchemy/Stack";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  capabilitiesOf,
  checkSupport,
  ensureDerivedSnapshot,
  installLinesOf,
  isMountCapability,
} from "./internal/Derived.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  createInternalLabels,
  definedLabels,
  hasAlchemyLabels,
  userLabels,
} from "./internal/Labels.ts";
import { resolveName } from "./internal/Names.ts";
import {
  bundleProgram,
  DEFAULT_PORT,
  deployProgram,
  isProgramRunning,
  type ProgramState,
} from "./internal/Program.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import { toMinutes, waitForState, waitUntilGone } from "./internal/Wait.ts";
import type { Providers } from "./Providers.ts";
import { deleteSnapshotByName } from "./Snapshot.ts";

/** A snapshot, by name. Accepts a `Daytona.Snapshot` or `{ name }`. */
export type SandboxSnapshot = { readonly name: string };
/** A volume, by id. Accepts a `Daytona.Volume` or `{ volumeId }`. */
export type SandboxVolumeRef = { readonly volumeId: string };
/** A secret, by name. Accepts a `Daytona.Secret` or `{ name }`. */
export type SandboxSecretRef = { readonly name: string };

/** A volume mounted into a sandbox. */
export interface SandboxMount {
  /** The volume to mount: a `Daytona.Volume`. */
  volume: Ref<SandboxVolumeRef>;
  /** Absolute path in the sandbox. */
  path: string;
  /** Mount only this directory of the volume. */
  subpath?: string;
}

/** A volume a binding mounts into a sandbox (`Daytona.MountVolume`). */
export interface SandboxVolumeBinding {
  volumeId: string;
  path: string;
  subpath?: string;
}

/**
 * What bindings attach to a sandbox that runs a program: environment
 * variables for the process, and `mounts`: volumes to mount
 * (`Daytona.MountVolume`), or `alchemy/Mount` capabilities whose clients
 * the sandbox's image needs (a derived snapshot installs them).
 */
export interface SandboxBinding {
  env?: Record<string, any>;
  mounts?: ReadonlyArray<SandboxVolumeBinding | MountCapability>;
}

/** Another sandbox, by id. Accepts a `Daytona.Sandbox` or `{ sandboxId }`. */
export type SandboxLinkRef = { readonly sandboxId: string };

/** Whether the sandbox should be running, stopped (disk kept) or archived (moved to object storage). */
export type SandboxRunState = "started" | "stopped" | "archived";

export interface SandboxProps extends PlatformProps {
  /**
   * Sandbox name, unique in the organization. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces
   * the sandbox.
   */
  name?: string;
  /**
   * Snapshot to boot from. Defaults to Daytona's default snapshot. The
   * snapshot sets the sandbox's CPU, memory, disk and GPUs: declare a
   * `Daytona.Snapshot` with the size you want. Changing it replaces the
   * sandbox.
   */
  snapshot?: Ref<SandboxSnapshot>;
  /** OS user commands run as. Changing it replaces the sandbox. */
  user?: string;
  /**
   * Environment variables. On a sandbox without `main` they are the
   * sandbox's, and changing them replaces it. On a sandbox with `main`
   * they are the program's, and changing them restarts it.
   */
  env?: Record<string, any>;
  /**
   * Secrets exposed as environment variables, keyed by variable name. The
   * sandbox sees each secret's placeholder; Daytona swaps in the value only
   * on requests to the secret's `hosts`. Updated in place.
   */
  secrets?: Record<string, Ref<SandboxSecretRef>>;
  /** Labels. Updated in place. */
  labels?: Record<string, string>;
  /** Whether preview URLs work without a token. Updated in place. @default false */
  public?: boolean;
  /** Block all outbound traffic. Updated in place. @default false */
  networkBlockAll?: boolean;
  /** CIDR ranges outbound traffic may reach (at most 10). Updated in place. */
  networkAllowList?: string[];
  /** Domains outbound traffic may reach (at most 100). Updated in place. */
  domainAllowList?: string[];
  /**
   * A forward proxy for the sandbox's HTTP(S) traffic, set as `HTTP_PROXY`
   * and `HTTPS_PROXY` in the sandbox, and enforced at the network only with a
   * `domainAllowList`. HTTPS reaches it as `CONNECT` tunnels, so a Cloudflare
   * Worker can't serve it. The sandbox can read the URL. Changing it
   * replaces the sandbox.
   */
  outboundProxyUrl?: string;
  /** Region. Changing it replaces the sandbox. */
  target?: string;
  /**
   * Run a GPU sandbox on spot capacity: cheaper, but Daytona can end it
   * without notice. Changing it replaces the sandbox.
   */
  spot?: boolean;
  /** Expose `/dev/kvm` (VM sandboxes). Changing it replaces the sandbox. */
  kvm?: boolean;
  /**
   * Volumes to mount. A program's `Daytona.MountVolume` bindings add to
   * them. Changing them replaces the sandbox.
   */
  mounts?: SandboxMount[];
  /** Stop after this long without activity. `0` never stops. Updated in place. @default "15 minutes" */
  autoStopInterval?: Duration.Input;
  /**
   * Pause (memory kept) after this long without activity. Only `linux-vm`
   * and `windows` sandboxes can pause; a container fails with
   * `AutoPauseNotSupported`. Updated in place.
   */
  autoPauseInterval?: Duration.Input;
  /** Archive after being stopped this long. Updated in place. @default "7 days" */
  autoArchiveInterval?: Duration.Input;
  /** Delete after being stopped this long. Updated in place. */
  autoDeleteInterval?: Duration.Input;
  /**
   * Destroy the sandbox this long after it is created (or after the deploy
   * that last changed it), whatever its state. Changing it restarts the
   * clock from now. `0` disables it, unless the region caps sandbox lifespan.
   */
  ttl?: Duration.Input;
  /**
   * Give up if no runner takes the sandbox within this long. The
   * organization needs the queue-timeout feature; without it, creating the
   * sandbox fails with `QueueTimeoutNotEnabled`. Only used when the sandbox
   * is created.
   */
  queueTimeout?: Duration.Input;
  /**
   * Schedule the sandbox on the same runner as this one, so the two share
   * a local network. Both must be ephemeral (`autoDeleteInterval: 0`), and
   * neither can have GPUs. Changing it replaces the sandbox.
   */
  linkedSandbox?: Ref<SandboxLinkRef>;
  /**
   * Send the sandbox's OpenTelemetry data here instead of Daytona's
   * collector. It then doesn't show in Daytona's dashboard or the
   * telemetry API. Changing it replaces the sandbox.
   */
  otelEndpointOverride?: string;
  /**
   * Whether the sandbox should be running, stopped (disk kept) or archived
   * (disk moved to object storage). Archiving can take many minutes, so a
   * deploy returns once Daytona has started it. Updated in place.
   * @default "started"
   */
  state?: SandboxRunState;
  /**
   * Module entrypoint of a program to run in the sandbox, typically
   * `import.meta.url` in the class form. Alchemy bundles it, uploads it
   * into the sandbox and runs it with Node; a code change uploads it again
   * and restarts the process, without replacing the sandbox. The snapshot
   * needs Node.js 20 or later (Daytona's default snapshot has Node 24).
   */
  main?: string;
  /**
   * Port the program listens on. Written to `PORT`; the sandbox's preview
   * URL of this port is `url`.
   * @default 3000
   */
  port?: number;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /** Bundler configuration for `main`. */
  build?: Bundle.BundleConfig;
}

export interface SandboxAttributes {
  /** Sandbox ID. */
  sandboxId: string;
  /** Sandbox name. */
  name: string;
  /** Organization ID. */
  organizationId: string;
  /** Snapshot it booted from. */
  snapshot: string | undefined;
  /** Current state. */
  state: sandboxes.SandboxState | undefined;
  /** Region. */
  target: string;
  /** vCPUs. */
  cpu: number;
  /** Memory in GiB. */
  memory: number;
  /** Disk in GiB. */
  disk: number;
  /** GPUs. */
  gpu: number;
  /** Sandbox class: `container`, `linux-vm` or `windows`, set by the snapshot. */
  sandboxClass: sandboxes.SandboxSandboxClass | undefined;
  /** When the TTL destroys the sandbox, if one is set. */
  autoDestroyAt: string | undefined;
  /** ID of the sandbox it shares a runner with. */
  linkedSandboxId: string | undefined;
  /** Labels you set (alchemy's ownership labels excluded). */
  labels: Record<string, string>;
  /** Whether previews are public. */
  public: boolean;
  /** Base URL of the sandbox's toolbox proxy. */
  toolboxProxyUrl: string;
  /**
   * Preview URL of the program's port, for a sandbox with `main`. It is
   * open when the sandbox is `public`; otherwise send the preview token
   * (`getPortPreviewUrl`) in `X-Daytona-Preview-Token`.
   */
  url: string | undefined;
  /** The program the sandbox runs, for a sandbox with `main`. */
  program: ProgramState | undefined;
  /**
   * The snapshot built for this sandbox when its bindings need clients
   * installed (`alchemy/Mount` capabilities): `FROM` its snapshot plus their
   * install lines. Deleted with the sandbox.
   */
  derivedSnapshot: string | undefined;
}

export type Sandbox = Resource<
  "Daytona.Sandbox",
  SandboxProps,
  SandboxAttributes,
  SandboxBinding,
  Providers,
  SandboxLookup
>;

/**
 * Props for {@link Sandbox.lookup}: find a sandbox this stack
 * doesn't manage by its name or id.
 */
export interface SandboxLookup {
  /** Sandbox name or id. */
  name: string;
}

export type SandboxServices = ServerHost;

/** A program's shape: a long-running server returning `{ fetch }`, or `host.run` loops. */
export type SandboxShape = Main<SandboxServices>;

export type SandboxRuntimeContext = HostRuntimeContext;

/**
 * A long-lived Daytona sandbox: an isolated machine with its own
 * filesystem, processes and network, for a dev box, a preview environment
 * or a persistent agent workspace. Its disk survives stops; Daytona stops
 * it when idle and archives it later, and deploy starts it again.
 *
 * The class form runs an Effect program in the sandbox: give it `main`
 * and an implementation, and Alchemy bundles the program, uploads it and
 * runs it with Node, served on the sandbox's preview URL (`url`). A code
 * change uploads the new bundle and restarts the process; the sandbox and
 * its URL stay the same. The process lives as long as the sandbox runs,
 * so a sandbox with `main` never auto-stops unless `autoStopInterval` says
 * so; if it stopped anyway, the next deploy starts it and the program.
 *
 * For sandboxes created per request or per task, use
 * {@link CreateSandbox} at runtime instead; for one declared here, use
 * {@link ConnectSandbox} to run commands in it from a Worker.
 * @see https://www.daytona.io/docs/en/sandboxes/
 *
 * ### Creating a Sandbox
 * **Example:** A dev box from a snapshot
 * ```typescript
 * export const DevBox = Daytona.Sandbox("DevBox", {
 *   snapshot: Base,
 *   autoStopInterval: "30 minutes",
 * });
 * ```
 *
 * ### Restricting the Network
 * **Example:** Only GitHub and npm are reachable
 * ```typescript
 * export const Locked = Daytona.Sandbox("Locked", {
 *   snapshot: Base,
 *   domainAllowList: ["github.com", "registry.npmjs.org"],
 * });
 * ```
 *
 * ### Volumes and Secrets
 * **Example:** A shared cache volume and an npm token only sent to npm
 * ```typescript
 * export const Builder = Daytona.Sandbox("Builder", {
 *   snapshot: Base,
 *   mounts: [{ volume: Cache, path: "/cache" }],
 *   secrets: { NPM_TOKEN: NpmToken },
 * });
 * ```
 *
 * ### Running a Program
 * **Example:** An HTTP server with a mounted volume
 * ```typescript
 * export default class Agent extends Daytona.Sandbox<Agent>()(
 *   "Agent",
 *   { snapshot: Base, main: import.meta.url, public: true },
 *   Effect.gen(function* () {
 *     const data = yield* Daytona.MountVolume(Data, { path: "/data" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* fs.readDirectory(data.path));
 *       }),
 *     };
 *   }).pipe(Effect.provide(Daytona.MountVolumeLive)),
 * ) {}
 * ```
 *
 * A mount binding that needs a client in the image (an `alchemy/Mount`
 * capability) makes the sandbox boot from a derived snapshot: its snapshot
 * plus the client's install lines, built on Daytona, named from a hash and
 * deleted with the sandbox. Sandboxes provide FUSE; a client that needs
 * NFS fails with `MountUnsupported`.
 *
 * The program reaches the internet as its sandbox does. Below Daytona's
 * Tier 3, sandboxes reach only an allowlist of essential services
 * (package registries, GitHub, AI APIs, Daytona's API), so bindings that
 * manage sandboxes work but toolbox calls are refused.
 *
 * ### GPUs
 * A GPU sandbox boots from a GPU snapshot, such as Daytona's `daytona-gpu`
 * (one H100) in its `earth` region, and must be ephemeral. The
 * organization needs GPU credits in its wallet.
 *
 * **Example:** An ephemeral H100 sandbox on spot capacity
 * ```typescript
 * export const Trainer = Daytona.Sandbox("Trainer", {
 *   snapshot: { name: "daytona-gpu" },
 *   target: "earth",
 *   autoDeleteInterval: 0,
 *   spot: true,
 * });
 * ```
 *
 * ### Limiting Its Lifetime
 * **Example:** Destroyed two hours after it is created
 * ```typescript
 * export const Scratch = Daytona.Sandbox("Scratch", { ttl: "2 hours" });
 * ```
 *
 * ### Sharing a Runner
 * **Example:** A database and an app on one local network
 * ```typescript
 * export const Db = Daytona.Sandbox("Db", { autoDeleteInterval: 0 });
 * export const App = Daytona.Sandbox("App", {
 *   autoDeleteInterval: 0,
 *   linkedSandbox: Db,
 * });
 * ```
 *
 * ### Looking up an existing sandbox
 * `Sandbox.lookup` references a sandbox Alchemy doesn't manage (created in
 * the Daytona dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 * `url` and `program` are `undefined`: they come from the deploy that started
 * the sandbox's program.
 *
 * **Example:** Reference an existing sandbox
 * ```typescript
 * const box = Daytona.Sandbox.lookup({ name: "research" });
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const Sandbox: Platform<Sandbox, SandboxServices, SandboxShape, SandboxRuntimeContext> &
  LookupMethod<Sandbox> = Platform("Daytona.Sandbox", {
  createRuntimeContext: createHostRuntimeContext("Daytona.Sandbox"),
  // A declaration passed as a prop (`snapshot: Base`) is an Effect until
  // yielded. Yield it here so it is registered and the prop resolves to
  // its attributes, as with `yield* Snapshot(...)` inside Effect.gen.
  transformProps: (_id, props: SandboxProps) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const ref = <T>(value: T) =>
        Effect.isEffect(value)
          ? (value as unknown as Effect.Effect<T, never, Providers>)
          : Effect.succeed(value);
      return {
        ...props,
        snapshot: props.snapshot === undefined ? undefined : yield* ref(props.snapshot),
        linkedSandbox:
          props.linkedSandbox === undefined ? undefined : yield* ref(props.linkedSandbox),
        secrets:
          props.secrets === undefined
            ? undefined
            : Object.fromEntries(
                yield* Effect.forEach(Object.entries(props.secrets), ([key, value]) =>
                  Effect.map(ref(value), (resolved) => [key, resolved] as const),
                ),
              ),
        mounts:
          props.mounts === undefined
            ? undefined
            : yield* Effect.forEach(props.mounts, (mount) =>
                Effect.map(ref(mount.volume), (volume) => ({ ...mount, volume })),
              ),
      };
    }),
});

const resolveRef = <T>(ref: Ref<T>) => Effect.succeed(resolved(ref));

const csv = (list: string[] | undefined) => (list === undefined ? undefined : list.join(","));
const fromCsv = (value: string | undefined) =>
  value === undefined || value === ""
    ? []
    : value
        .split(",")
        .map((s) => s.trim())
        .sort();

/** What both `getSandbox` and the sandbox list return. */
export type SandboxInfo = Omit<sandboxes.Sandbox2, "env" | "kvm">;

export const toSandboxAttributes = (s: SandboxInfo): SandboxAttributes => ({
  sandboxId: s.id,
  name: s.name,
  organizationId: s.organizationId,
  snapshot: s.snapshot,
  state: s.state,
  target: s.target,
  cpu: s.cpu,
  memory: s.memory,
  disk: s.disk,
  gpu: s.gpu,
  sandboxClass: s.sandboxClass,
  autoDestroyAt: s.autoDestroyAt,
  linkedSandboxId: s.linkedSandboxId,
  labels: userLabels(s.labels),
  public: s.public,
  toolboxProxyUrl: s.toolboxProxyUrl,
  url: undefined,
  program: undefined,
  derivedSnapshot: undefined,
});

type BoundMount = SandboxVolumeBinding;

/**
 * The snapshot the sandbox was declared with. A sandbox booted from a
 * derived snapshot reports that one, so the declared base is read from
 * the last deploy's props.
 */
const bootedFrom = Effect.fn(function* (olds: SandboxProps | undefined, output: SandboxAttributes) {
  if (output.derivedSnapshot === undefined) return output.snapshot;
  return olds?.snapshot ? (yield* resolveRef(olds.snapshot)).name : undefined;
});

/** The bindings still attached (a removed binding arrives as a `delete`). */
const activeBindings = (bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>) =>
  bindings.filter(
    (binding: ResourceBinding<SandboxBinding> & { action?: string }) => binding.action !== "delete",
  );

/**
 * Every volume the sandbox mounts: its `mounts` and what bindings added, in
 * a stable order. At plan, a volume created in the same deploy has no id
 * yet; it compares as unresolved, which differs from any mounted volume.
 */
const allMounts = Effect.fn(function* (
  props: SandboxProps | undefined,
  bindings: ReadonlyArray<ResourceBinding<SandboxBinding>> | ReadonlyArray<unknown>,
) {
  const declared = yield* Effect.forEach(props?.mounts ?? [], (m) =>
    Effect.map(resolveRef(m.volume), (v): BoundMount => ({
      volumeId: typeof v?.volumeId === "string" ? v.volumeId : "(unresolved)",
      path: m.path,
      subpath: m.subpath,
    })),
  );
  const bound = activeBindings(bindings as ReadonlyArray<ResourceBinding<SandboxBinding>>)
    .flatMap((b) => (b.data?.mounts ?? []).filter((m) => !isMountCapability(m)))
    .map((m) => m as SandboxVolumeBinding)
    .map((m) => ({ ...m, volumeId: typeof m.volumeId === "string" ? m.volumeId : "(unresolved)" }));
  const seen = new Set<string>();
  return [...declared, ...bound]
    .filter((m) => {
      const key = `${m.volumeId}:${m.path}:${m.subpath ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
});

/** The program's environment: bindings' env, alchemy's, the port, then the props'. */
const bindingEnv = (bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>) =>
  activeBindings(bindings).reduce<Record<string, any>>(
    (acc, binding) => ({ ...acc, ...binding.data?.env }),
    {},
  );

const isGone = (s: SandboxInfo) => s.state === "destroyed" || s.state === "destroying";

export const getSandbox = (idOrName: string) =>
  sandboxes.getSandbox({ sandboxIdOrName: idOrName }).pipe(
    Effect.map((s) => (isGone(s) ? undefined : s)),
    Effect.catchTag("SandboxNotFound", () => Effect.undefined),
  );

const TRANSITIONS: Partial<Record<string, readonly string[]>> = {
  started: ["started"],
  stopped: ["stopped"],
  // Archiving moves the disk to object storage in the background, and can
  // take many minutes; the sandbox is on its way once Daytona accepts it.
  archived: ["archived", "archiving"],
};

export const waitForSandbox = (idOrName: string, want: SandboxRunState | "paused" = "started") =>
  waitForState({
    kind: "sandbox",
    id: idOrName,
    observe: sandboxes.getSandbox({ sandboxIdOrName: idOrName }),
    want: TRANSITIONS[want] ?? [want],
    fail: ["error", "build_failed", "destroyed"],
    reason: (s) => s.errorReason,
    budget: "10 minutes",
  });

/** Move a sandbox to the run state it should be in. */
export const syncRunState = Effect.fn(function* (
  current: sandboxes.Sandbox2,
  want: SandboxRunState,
) {
  const id = current.id;
  let state = current.state;
  if (want === "archived" && state === "archiving") return current;
  // Let an in-flight transition land first.
  if (state && !["started", "stopped", "archived", "paused", "error"].includes(state)) {
    state = (yield* waitForState({
      kind: "sandbox",
      id,
      observe: sandboxes.getSandbox({ sandboxIdOrName: id }),
      want: ["started", "stopped", "archived", "paused", "error"],
      budget: "10 minutes",
    })).state;
  }
  if (state === "error") {
    if (current.recoverable) {
      yield* sandboxes.recoverSandbox({ sandboxIdOrName: id });
      state = (yield* waitForSandbox(id, "started")).state;
    } else {
      return yield* waitForSandbox(id, "started");
    }
  }
  if (state === want) return yield* sandboxes.getSandbox({ sandboxIdOrName: id });
  if (want === "started") {
    yield* sandboxes.startSandbox({ sandboxIdOrName: id });
    return yield* waitForSandbox(id, "started");
  }
  if (want === "stopped") {
    if (state === "archived") {
      // An archived sandbox only leaves the archive by starting.
      yield* sandboxes.startSandbox({ sandboxIdOrName: id });
      yield* waitForSandbox(id, "started");
    }
    yield* sandboxes.stopSandbox({ sandboxIdOrName: id });
    return yield* waitForSandbox(id, "stopped");
  }
  if (state === "started" || state === "paused") {
    yield* sandboxes.stopSandbox({ sandboxIdOrName: id });
    yield* waitForSandbox(id, "stopped");
  }
  yield* sandboxes.archiveSandbox({ sandboxIdOrName: id });
  return yield* waitForSandbox(id, "archived");
});

export const deleteSandboxById = Effect.fn(function* (idOrName: string) {
  yield* sandboxes
    .deleteSandbox({ sandboxIdOrName: idOrName })
    .pipe(Effect.catchTag("SandboxNotFound", () => Effect.void));
  yield* waitUntilGone(
    "sandbox",
    idOrName,
    getSandbox(idOrName).pipe(Effect.map((s) => s !== undefined)),
    "5 minutes",
  );
});

const resolveCreate = Effect.fn(function* (
  name: string,
  news: SandboxProps,
  labels: Record<string, string>,
  mounts: ReadonlyArray<BoundMount>,
) {
  const snapshot = news.snapshot ? (yield* resolveRef(news.snapshot)).name : undefined;
  const volumes =
    mounts.length > 0
      ? mounts.map((m) => ({ volumeId: m.volumeId, mountPath: m.path, subpath: m.subpath }))
      : undefined;
  const secrets = news.secrets
    ? yield* Effect.forEach(Object.entries(news.secrets), ([env, ref]) =>
        Effect.map(resolveRef(ref), (s) => ({ [env]: s.name })),
      )
    : undefined;
  const linkedSandbox = news.linkedSandbox
    ? (yield* resolveRef(news.linkedSandbox)).sandboxId
    : undefined;
  return {
    name,
    snapshot,
    linkedSandbox,
    otelEndpointOverride: news.otelEndpointOverride,
    ttlMinutes: toMinutes(news.ttl),
    queueTimeout: toMinutes(news.queueTimeout),
    user: news.user,
    // A program's env is the process's, written at deploy, not the sandbox's.
    env: news.main === undefined ? news.env : undefined,
    labels,
    public: news.public,
    networkBlockAll: news.networkBlockAll,
    networkAllowList: csv(news.networkAllowList),
    domainAllowList: csv(news.domainAllowList),
    outboundProxyUrl: news.outboundProxyUrl,
    target: news.target,
    spot: news.spot,
    kvm: news.kvm,
    volumes,
    secrets,
    // A program serves for as long as the sandbox runs: don't stop it when idle.
    autoStopInterval: toMinutes(news.autoStopInterval ?? (news.main !== undefined ? 0 : undefined)),
    autoPauseInterval: toMinutes(news.autoPauseInterval),
    autoArchiveInterval: toMinutes(news.autoArchiveInterval),
    autoDeleteInterval: toMinutes(news.autoDeleteInterval),
  } satisfies sandboxes.CreateSandboxRequest;
});

export const SandboxProvider = () =>
  Provider.effect(
    Sandbox,
    Effect.gen(function* () {
      const stack = yield* Stack;
      // The bundled program's bootstrap reads these to rebuild the Stack at runtime.
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
        HOST: "0.0.0.0",
      };
      return {
        stables: ["sandboxId", "organizationId", "toolboxProxyUrl"],
        list: Effect.fn(function* () {
          const all = yield* sandboxes.listSandboxes.items({}).pipe(Stream.runCollect);
          return Array.from(all)
            .filter(
              (s) =>
                !isGone(s) &&
                Object.keys(s.labels ?? {}).some((k) => k.startsWith(ALCHEMY_LABEL_PREFIX)),
            )
            .map(toSandboxAttributes);
        }),
        diff: Effect.fn(function* ({ id, olds, news, output, oldBindings, newBindings }) {
          if (output === undefined) return undefined;
          // A program's props are partly unresolved at plan (its bindings' env
          // holds Outputs), so each field is compared once it is known.
          const props = news as SandboxProps;
          const known = isResolved;
          const name = known(props.name)
            ? yield* resolveName(id, props.name, props.name === undefined ? output.name : undefined)
            : output.name;
          const snapshot =
            props.snapshot && known(props.snapshot)
              ? (yield* resolveRef(props.snapshot)).name
              : undefined;
          const linked =
            props.linkedSandbox && known(props.linkedSandbox)
              ? (yield* resolveRef(props.linkedSandbox)).sandboxId
              : undefined;
          const replace =
            name !== output.name ||
            (snapshot !== undefined && snapshot !== (yield* bootedFrom(olds, output))) ||
            (known(props.user) && props.user !== olds?.user) ||
            // A sandbox env is set at create; a program's restarts the program.
            (props.main === undefined) !== (olds?.main === undefined) ||
            (props.main === undefined &&
              known(props.env) &&
              !deepEqual(props.env ?? {}, olds?.env ?? {})) ||
            (known(props.outboundProxyUrl) && props.outboundProxyUrl !== olds?.outboundProxyUrl) ||
            (known(props.target) && props.target !== undefined && props.target !== output.target) ||
            props.spot !== olds?.spot ||
            props.kvm !== olds?.kvm ||
            (known(props.otelEndpointOverride) &&
              props.otelEndpointOverride !== olds?.otelEndpointOverride) ||
            (linked !== undefined && linked !== output.linkedSandboxId) ||
            !deepEqual(
              yield* allMounts(props, Array.isArray(newBindings) ? newBindings : []),
              yield* allMounts(olds, oldBindings ?? []),
            );
          // A change to the clients bindings need rebuilds the derived snapshot.
          // Bindings may hold Outputs at plan; capabilities are plain data.
          const caps = capabilitiesOf(
            (Array.isArray(newBindings) ? newBindings : []) as ReadonlyArray<
              ResourceBinding<SandboxBinding>
            >,
          );
          yield* checkSupport(caps);
          const installChanged = !deepEqual(
            installLinesOf(caps),
            installLinesOf(capabilitiesOf(oldBindings ?? [])),
          );
          if (replace || installChanged) {
            return { action: "replace", deleteFirst: name === output.name } as const;
          }
          // The bundle depends only on `main`, `handler` and `build`, which are plain.
          if (typeof props.main === "string") {
            // A code change, or a process that ended (the sandbox restarted),
            // redeploys the program in place.
            const { hash } = yield* bundleProgram({ ...props, main: props.main });
            if (output.program === undefined || hash !== output.program.codeHash) {
              return { action: "update" } as const;
            }
            if (!(yield* isProgramRunning(output.sandboxId, output.program))) {
              return { action: "update" } as const;
            }
          }
        }),
        lookup: Effect.fn(function* ({ name }) {
          const found = yield* getSandbox(name);
          return found === undefined
            ? undefined
            : {
                ...toSandboxAttributes(found),
                url: undefined,
                program: undefined,
                derivedSnapshot: undefined,
              };
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = yield* getSandbox(
            output?.sandboxId ?? (yield* resolveName(id, olds?.name, output?.name)),
          );
          if (found === undefined) return undefined;
          // The program isn't visible on the sandbox; keep what the last deploy recorded.
          const attrs = {
            ...toSandboxAttributes(found),
            url: output?.url,
            program: output?.program,
            derivedSnapshot: output?.derivedSnapshot,
          };
          return (yield* hasAlchemyLabels(id, found.labels)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings, session }) {
          const name = yield* resolveName(id, news.name, output?.name);
          const labels = { ...news.labels, ...(yield* createInternalLabels(id)) };
          const mounts = yield* allMounts(news, bindings);
          const base = yield* resolveCreate(name, news, labels, mounts);
          // Clients bindings need are installed into a snapshot derived from the base.
          const caps = capabilitiesOf(bindings);
          yield* checkSupport(caps);
          const derivedSnapshot =
            caps.length > 0
              ? yield* ensureDerivedSnapshot({
                  sandboxName: name,
                  snapshot: base.snapshot,
                  caps,
                  note: session.note,
                })
              : undefined;
          const request = derivedSnapshot ? { ...base, snapshot: derivedSnapshot } : base;

          // Observe
          let current = yield* getSandbox(output?.sandboxId ?? name);
          const created = current === undefined;

          // Ensure
          if (current === undefined) {
            yield* session.note(`Creating sandbox ${name}...`);
            current = yield* sandboxes
              .createSandbox(request)
              .pipe(
                Effect.catchTag("SandboxAlreadyExists", () =>
                  sandboxes.getSandbox({ sandboxIdOrName: name }),
                ),
              );
            current = yield* waitForSandbox(current.id, "started");
          }
          const sandboxId = current.id;

          // Sync labels against the observed set.
          if (!deepEqual(definedLabels(current.labels), labels)) {
            yield* sandboxes.replaceLabels({ sandboxIdOrName: sandboxId, labels });
          }
          // Sync network.
          const network = {
            networkBlockAll: news.networkBlockAll ?? false,
            networkAllowList: fromCsv(request.networkAllowList),
            domainAllowList: fromCsv(request.domainAllowList),
          };
          if (
            network.networkBlockAll !== current.networkBlockAll ||
            !deepEqual(network.networkAllowList, fromCsv(current.networkAllowList)) ||
            !deepEqual(network.domainAllowList, fromCsv(current.domainAllowList))
          ) {
            yield* sandboxes.updateNetworkSettings({
              sandboxIdOrName: sandboxId,
              networkBlockAll: network.networkBlockAll,
              networkAllowList: network.networkAllowList.join(","),
              domainAllowList: network.domainAllowList.join(","),
            });
          }
          // Sync public previews.
          if ((news.public ?? false) !== current.public) {
            yield* sandboxes.updatePublicStatus({
              sandboxIdOrName: sandboxId,
              isPublic: news.public ?? false,
            });
          }
          // Sync lifecycle intervals that were declared.
          const intervals = [
            [request.autoStopInterval, current.autoStopInterval, sandboxes.setAutostopInterval],
            [request.autoPauseInterval, current.autoPauseInterval, sandboxes.setAutoPauseInterval],
            [
              request.autoArchiveInterval,
              current.autoArchiveInterval,
              sandboxes.setAutoArchiveInterval,
            ],
            [
              request.autoDeleteInterval,
              current.autoDeleteInterval,
              sandboxes.setAutoDeleteInterval,
            ],
          ] as const;
          for (const [want, have, set] of intervals) {
            if (want !== undefined && want !== have) {
              yield* set({ sandboxIdOrName: sandboxId, interval: want });
            }
          }
          // Sync the TTL. Daytona reports only when it fires, and setting it
          // restarts the clock, so it's written when the declared TTL changes
          // (or on adoption).
          if (
            !created &&
            request.ttlMinutes !== undefined &&
            (olds === undefined || request.ttlMinutes !== toMinutes(olds.ttl))
          ) {
            yield* sandboxes.setTtl({ sandboxIdOrName: sandboxId, ttlMinutes: request.ttlMinutes });
          } else if (!created && request.ttlMinutes === undefined && olds?.ttl !== undefined) {
            yield* sandboxes.setTtl({ sandboxIdOrName: sandboxId, ttlMinutes: 0 });
          }
          // Sync secrets. Daytona doesn't report a sandbox's mounted secrets,
          // so the declared set is written whenever it differs from the last
          // deploy (or on adoption, when there is no last deploy).
          if (request.secrets !== undefined || olds?.secrets !== undefined) {
            const previous = olds?.secrets
              ? yield* resolveCreate(name, olds, labels, mounts)
              : undefined;
            if (olds === undefined || !deepEqual(previous?.secrets ?? [], request.secrets ?? [])) {
              yield* sandboxes.updateSandboxSecrets({
                sandboxIdOrName: sandboxId,
                secrets: request.secrets ?? [],
              });
            }
          }
          // Sync run state last, from a fresh observation.
          const final = yield* syncRunState(
            yield* sandboxes.getSandbox({ sandboxIdOrName: sandboxId }),
            news.state ?? "started",
          );
          const attrs = { ...toSandboxAttributes(final), derivedSnapshot };
          // Deploy the program into the running sandbox.
          if (news.main === undefined || final.state !== "started") return attrs;
          const port = news.port ?? DEFAULT_PORT;
          const program = yield* deployProgram({
            id,
            sandboxId,
            toolboxProxyUrl: final.toolboxProxyUrl,
            source: { ...news, main: news.main },
            port,
            env: { ...bindingEnv(bindings), ...alchemyEnv, PORT: String(port), ...news.env },
            // A replaced sandbox runs nothing yet.
            previous: output?.sandboxId === sandboxId ? output.program : undefined,
            note: session.note,
          });
          return { ...attrs, url: program.url, program: program.state };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSandboxById(output.sandboxId);
          if (output.derivedSnapshot) yield* deleteSnapshotByName(output.derivedSnapshot);
        }),
      };
    }),
  );
