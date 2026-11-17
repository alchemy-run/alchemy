import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import * as archil from "@distilled.cloud/archil";
import * as Process from "@distilled.cloud/archil/Process";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Bundle from "alchemy/Bundle/Bundle";
import { deepEqual, isResolved } from "alchemy/Diff";
import {
  checkMountSupport,
  collectMountCapabilities,
  mountEnv,
  mountInstallLines,
  type MountCapability,
} from "alchemy/Mount";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { LookupMethod, Resource, ResourceBinding } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { Stack } from "alchemy/Stack";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Disk } from "./Disk.ts";
import {
  capabilities as imageCapabilities,
  ImageRequiresBuild,
  publishPlan,
  pullImage,
  type ImagePush,
} from "./Image.ts";
import {
  deletableSandboxStates,
  findSandboxByName,
  getSandbox,
  isAlchemyName,
  isRuntimeObjectName,
  listSandboxes,
  sandboxName,
  waitForSandbox,
  waitForSandboxGone,
  waitForSandboxStopped,
} from "./internal/archil.ts";
import {
  bundleProgram,
  deployProgram,
  removeProgram,
  type ProgramBuildOptions,
  type ProgramExtraFile,
} from "./internal/hosted.ts";
import type { Providers } from "./Providers.ts";
import {
  egressIdentity,
  MountDiskUnresolved,
  mountDiskId,
  mountIdentity,
  splitArchilEgress,
  toEgressPolicy,
  toEnv,
  toSandboxMount,
  type DiskMount,
  type DiskMountOptions,
  type SandboxEgress,
  type SandboxEndpoint,
} from "./SandboxOptions.ts";

/** A disk a binding mounts into a program sandbox (`MountDisk` inside one). */

/** A sandbox's `run` command exited non-zero. */
export class SandboxSetupFailed extends Data.TaggedError("Archil.SandboxSetupFailed")<{
  readonly sandbox: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message() {
    return `\`${this.command}\` exited ${this.exitCode} in sandbox ${this.sandbox}: ${this.stderr.slice(-2000)}`;
  }
}

export interface SandboxMountBinding extends DiskMountOptions {
  readonly diskId: string;
}

/**
 * What bindings attach to a sandbox: its program's environment, disks it
 * mounts natively (`SandboxMountBinding`), and filesystem clients other
 * mount bindings install into its image (`MountCapability`, from
 * `alchemy/Mount`).
 */
export interface SandboxBinding {
  env?: Record<string, any>;
  mounts?: ReadonlyArray<SandboxMountBinding | MountCapability>;
}

export interface SandboxProps extends PlatformProps {
  /**
   * Sandbox name, unique within your account: lowercase letters, digits
   * and `-`, at most 63 characters. If omitted, a unique name is generated
   * from the stack, stage, and logical ID. Changing it replaces the sandbox.
   */
  name?: string;
  /**
   * Image id from an {@link Image} (e.g. `image.imageId`), for a private
   * image or a pinned digest. Exclusive with `baseImage`. Changing it
   * replaces the sandbox.
   */
  image?: string;
  /**
   * Public OCI image reference with a `linux/amd64` manifest. Exclusive
   * with `image`. Changing it replaces the sandbox.
   * @default "node:24-bookworm"
   */
  baseImage?: string;
  /** vCPUs, 1–32. Changing it replaces the sandbox. @default 1 */
  vcpuCount?: number;
  /** Memory in MiB, 256–65536. Changing it replaces the sandbox. @default 2048 */
  memSizeMiB?: number;
  /**
   * TCP ports to serve publicly. Updated in place. When set, it is the
   * whole list (plus the program's `port`): ports not in it are unexposed.
   */
  ports?: number[];
  /**
   * Let services inside the sandbox publish their own ingress.
   * Changing it replaces the sandbox. @default false
   */
  enableServiceIngress?: boolean;
  /**
   * Environment variables. With `main`, they are the program's environment
   * and a change restarts it. Without `main`, every process in the sandbox
   * gets them, and a change replaces the sandbox.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /** Outbound network policy. Updated in place. */
  network?: { egress?: SandboxEgress };
  /**
   * Disks to mount: a declared `Archil.Disk` (or the Effect that declares
   * it) at a `path`. Updated in place: the sandbox stops, then starts with
   * the new mounts, keeping its root filesystem.
   */
  mounts?: DiskMount[];
  /**
   * Seconds a powered-on session may run before the sandbox pauses
   * (at most 24 hours). Changing it replaces the sandbox.
   */
  maxTtlSeconds?: number;
  /**
   * Seconds without a process connection before the sandbox pauses.
   * `0` disables idle expiry. Updated in place.
   */
  idleTtlSeconds?: number;
  /** Concurrent processes allowed. Changing it replaces the sandbox. */
  maxConcurrentExecs?: number;
  /**
   * Shell commands run in the sandbox, in order, once it is created: clone
   * a repository, install packages, warm a cache. A non-zero exit fails the
   * deploy with `SandboxSetupFailed`. Changing them replaces the sandbox,
   * so it starts again from its image and runs the new commands. Fork the
   * result at run time with `Archil.CreateSandbox(sandbox)`.
   */
  run?: string[];
  /**
   * A program to run in the sandbox. In the Effect form, `import.meta.url`
   * (the file is both the bundle entry and the program). In the async form,
   * a path to a module whose default export has `fetch(request, env)`.
   * A code change uploads it and restarts the program in place.
   */
  main?: string;
  /** Named export to load from `main`. @default "default" */
  handler?: string;
  /**
   * TCP port the program listens on, passed to it as `PORT`. Alchemy
   * exposes it publicly and returns its URL as `url`.
   * @default 3000
   */
  port?: number;
  /**
   * Bundler options for `main` (rolldown `input` / `output`), and
   * `install`: packages to `npm install` next to the program instead of
   * bundling them.
   */
  build?: ProgramBuildOptions;
  /**
   * Host files or directories uploaded with the program, e.g. a site's
   * built assets. With `extraFiles`, an async `main` is treated as a
   * complete Node program and uploaded as built instead of bundled.
   * Their content is part of `code.hash`, so a change redeploys.
   */
  extraFiles?: ReadonlyArray<ProgramExtraFile>;
  /**
   * Where Alchemy pushes the sandbox's derived image, for Archil to pull.
   * Only needed when a binding installs a filesystem client (an
   * `alchemy/Mount` capability) into the program's image: Alchemy builds
   * the base image plus those install lines with your local Docker.
   */
  push?: ImagePush;
}

export interface SandboxAttributes {
  /** Sandbox id. */
  sandboxId: string;
  /** Sandbox name. */
  name: string;
  /** Lifecycle state when last observed, e.g. `running` or `paused`. */
  status: string;
  /** The image reference the sandbox boots. */
  baseImage: string;
  /** Digest of the booted image. */
  imageDigest: string | undefined;
  vcpuCount: number;
  memSizeMiB: number;
  /** Public hostnames of the exposed ports. */
  endpoints: SandboxEndpoint[];
  /** `https://` URL of the program's port, or of the first exposed port. */
  url: string | undefined;
  /** The port the program listens on, when the sandbox runs one. */
  port: number | undefined;
  /** Content hash of the deployed program, when the sandbox runs one. */
  code: { hash: string } | undefined;
  /**
   * The image Alchemy built for the sandbox (its base plus the install
   * lines its bindings contribute), when it needed one.
   */
  derivedImage: { imageId: string; hash: string } | undefined;
  /** Hash of the `run` commands the sandbox was set up with. */
  setupHash: string | undefined;
}

export type Sandbox = Resource<
  "Archil.Sandbox",
  SandboxProps,
  SandboxAttributes,
  SandboxBinding,
  Providers,
  SandboxLookup
>;

/**
 * Props for {@link Sandbox.lookup}: find a sandbox this stack
 * doesn't manage by its name.
 */
export interface SandboxLookup {
  /** Sandbox name. */
  name: string;
}

export type SandboxShape = Main<ServerHost>;

/**
 * An Archil sandbox: a Firecracker microVM with disks mounted, public
 * ports, and an outbound network policy that can inject credentials at the
 * boundary. It pauses when idle and resumes on the next connection,
 * keeping its memory.
 *
 * Declare one as a box (a dev box or a preview environment that outlives
 * deploys), or give it a `main` and it runs your program: Alchemy bundles
 * it, uploads it, and registers it with Archil's service manager, which
 * restarts it when it crashes and starts it whenever the sandbox boots. Its
 * port gets a public `https://` URL, and a request to a stopped sandbox
 * starts it again, typically in a few seconds. A code change uploads the
 * program and restarts it in place.
 *
 * Short-lived sandboxes for one user or task are created at run time with
 * {@link CreateSandbox}; act on a declared one with {@link ConnectSandbox}.
 *
 * :::caution
 * Changing the image, size, timeouts, or the `env` of a sandbox without
 * `main` replaces the sandbox, and a new one starts with an empty root
 * filesystem. Keep data on a mounted disk. `mounts`, `ports`, `network`
 * and the program update in place.
 * :::
 *
 * :::caution
 * An exposed port is public: anyone with the URL can call it. Check
 * requests yourself, or hand clients an `Archil.SandboxPortToken`.
 * :::
 * @see https://docs.archil.com/compute/sandboxes/introduction
 *
 * ### Creating a Sandbox
 * **Example:** A dev box with a disk mounted
 * ```typescript
 * export const Workspace = Archil.Disk("Workspace", {});
 * export const DevBox = Archil.Sandbox("DevBox", {
 *   baseImage: "node:24-bookworm",
 *   vcpuCount: 2,
 *   memSizeMiB: 4096,
 *   mounts: [{ disk: Workspace, path: "/workspace" }],
 *   ports: [3000],
 *   idleTtlSeconds: 600,
 * });
 * ```
 *
 * **Example:** A bigger sandbox that never pauses while idle
 * ```typescript
 * export const Box = Archil.Sandbox("Box", {
 *   vcpuCount: 4,
 *   memSizeMiB: 8192,
 *   idleTtlSeconds: 0,
 * });
 * ```
 *
 * **Example:** Boot a private image
 * ```typescript
 * export const AgentImage = Archil.Image("AgentImage", {
 *   image: "ghcr.io/acme/agent:1",
 *   registry: { server: "ghcr.io", username: "acme", password: Config.Redacted("GHCR_TOKEN") },
 * });
 * export const Agent = Effect.gen(function* () {
 *   const image = yield* AgentImage;
 *   return yield* Archil.Sandbox("Agent", { image: image.imageId });
 * });
 * ```
 *
 * ### Setting Up at Deploy and Forking at Run Time
 * **Example:** Clone a repository once, then fork the sandbox per task
 * ```typescript
 * export const Golden = Archil.Sandbox("Golden", {
 *   run: ["git clone --depth 1 https://github.com/sindresorhus/is /work/is"],
 * });
 *
 * // in a Worker or program:
 * const sandboxes = yield* Archil.CreateSandbox(Golden);
 * const task = yield* sandboxes.create({ name: "task-1" });
 * const result = yield* task.exec("git log -1", { cwd: "/work/is" });
 * ```
 *
 * ### Running a Program
 * **Example:** An Effect program that reads a mounted disk
 * ```typescript
 * // src/Api.ts
 * import * as Archil from "@alchemy.run/archil";
 * import * as Effect from "effect/Effect";
 * import * as FileSystem from "effect/FileSystem";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Dataset = Archil.Disk("Dataset", {});
 *
 * export default class Api extends Archil.Sandbox<Api>()(
 *   "Api",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const dataset = yield* Archil.MountDisk(Dataset, { path: "/data", mode: "read-only" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* fs.readDirectory(dataset.path));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Archil.MountDiskLive)),
 * ) {}
 * ```
 *
 * **Example:** A plain async handler with typed `env`
 * ```typescript
 * // src/infra.ts
 * export const Hello = Archil.Sandbox("Hello", {
 *   main: "./src/hello.ts",
 *   env: { GREETING: "hello" },
 * });
 * export type HelloEnv = Archil.InferEnv<typeof Hello>;
 * ```
 *
 * ```typescript
 * // src/hello.ts
 * import type { HelloEnv } from "./infra.ts";
 *
 * export default {
 *   async fetch(request: Request, env: HelloEnv) {
 *     return new Response(`${env.GREETING} from ${new URL(request.url).pathname}`);
 *   },
 * };
 * ```
 *
 * **Example:** Secrets in the program's environment
 * ```typescript
 * export const Billing = Archil.Sandbox("Billing", {
 *   main: "./src/billing.ts",
 *   env: { STRIPE_KEY: Config.Redacted("STRIPE_KEY") },
 * });
 * ```
 *
 * ### Mounting Disks
 * Archil sandboxes mount disks natively. Each entry names the disk and a
 * `path`, with Archil's own options: `mode` (`exclusive`, `conditional`
 * or `read-only`), `subdirectory`, and `queueMs`.
 *
 * **Example:** Mount two disks, one read-only
 * ```typescript
 * export const Box = Archil.Sandbox("Box", {
 *   mounts: [
 *     { disk: Workspace, path: "/workspace" },
 *     { disk: Dataset, path: "/data", mode: "read-only" },
 *   ],
 * });
 * ```
 *
 * **Example:** Mount from the program with `MountDisk`
 * ```typescript
 * const uploads = yield* Archil.MountDisk(Uploads, { path: "/uploads", mode: "conditional" });
 * // runtime: the disk is already mounted at uploads.path
 * yield* fs.writeFileString(`${uploads.path}/${id}.txt`, body);
 * ```
 *
 * ### Mount Clients From Other Bindings
 * A binding that installs a filesystem client (an `alchemy/Mount`
 * capability) into a program's image makes Alchemy build one: the
 * sandbox's base plus the client's install lines, built with your local
 * Docker and pushed to `push.repository` for Archil to pull. A different
 * set of clients replaces the sandbox.
 *
 * **Example:** Give a program sandbox a repository for its derived image
 * ```typescript
 * export default class Indexer extends Archil.Sandbox<Indexer>()(
 *   "Indexer",
 *   {
 *     main: import.meta.url,
 *     push: {
 *       repository: "ghcr.io/acme/indexer",
 *       credentials: { server: "ghcr.io", username: "acme-bot", password: Alchemy.Secret("GHCR_TOKEN") },
 *     },
 *   },
 *   Effect.gen(function* () {
 *     const media = yield* Cloud.MountBucket(Media, { path: "/media" }); // installs a FUSE client
 *     return { fetch: Effect.succeed(HttpServerResponse.text(media.path)) };
 *   }),
 * ) {}
 * ```
 *
 * ### Packaging
 * Alchemy bundles `main` with rolldown into one Node program. Packages
 * that can't be bundled (native modules, or ones that read their own files
 * at run time) go in `build.install` and are installed next to it with
 * `npm install`.
 *
 * **Example:** Install a native package
 * ```typescript
 * export const Thumbs = Archil.Sandbox("Thumbs", {
 *   main: "./src/thumbs.ts",
 *   build: { install: ["sharp"] },
 * });
 * ```
 *
 * **Example:** Upload static files next to the program
 * ```typescript
 * export const Site = Archil.Sandbox("Site", {
 *   main: "./dist/server.mjs",
 *   extraFiles: [{ source: "./dist/client", destination: "client" }],
 * });
 * ```
 *
 * ### Ports
 * **Example:** Serve a port and hand out a token for it
 * ```typescript
 * export const Preview = Archil.Sandbox("Preview", { ports: [8080] });
 * export const PreviewToken = Effect.gen(function* () {
 *   const preview = yield* Preview;
 *   return yield* Archil.SandboxPortToken("PreviewToken", {
 *     sandbox: preview.sandboxId,
 *     port: 8080,
 *     ttl: "24h",
 *   });
 * });
 * ```
 *
 * ### Network Policy
 * **Example:** Deny by default, inject a token for one API
 * ```typescript
 * export const Agent = Archil.Sandbox("Agent", {
 *   network: {
 *     egress: {
 *       default: "deny",
 *       allow: [
 *         "registry.npmjs.org",
 *         { target: "api.github.com", headers: { Authorization: Alchemy.Secret("GITHUB_AUTH") } },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Forward an API's requests to a Worker gateway that adds the key
 * ```typescript
 * const gateway = yield* MyGateway;
 * const sandbox = yield* Archil.Sandbox("MySandbox", {
 *   network: {
 *     egress: {
 *       default: "deny",
 *       allow: [
 *         {
 *           target: "api.example.com",
 *           // proves to the gateway that the request came through this policy
 *           headers: { "X-Gateway-Token": Config.Redacted("GATEWAY_TOKEN") },
 *           forwardUrl: gateway.url.as<string>(),
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Using a Sandbox at Run Time
 * **Example:** Run a command and fork a preview from a Worker
 * ```typescript
 * const preview = yield* Archil.ConnectSandbox(Preview);
 * const result = yield* preview.exec("pnpm build", { cwd: "/workspace" });
 * const fork = yield* preview.fork({ name: "pr-42" });
 * ```
 *
 * ### Looking up an existing sandbox
 * `Sandbox.lookup` references a sandbox Alchemy doesn't manage (created in
 * the Archil console or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 * Its program fields are `undefined`: they come from the deploy that started
 * the sandbox's program.
 *
 * **Example:** Reference an existing sandbox
 * ```typescript
 * const box = Archil.Sandbox.lookup({ name: "research" });
 * ```
 *
 * @resource
 * @product Sandbox
 */
export const Sandbox: Platform<Sandbox, ServerHost, SandboxShape, HostRuntimeContext> &
  LookupMethod<Sandbox> = Platform("Archil.Sandbox", {
  createRuntimeContext: createHostRuntimeContext("Archil.Sandbox"),
  // `{ disk: Workspace }` at module scope is an Effect: yield it here so
  // the disk is registered and `news.mounts[i].disk` resolves to its
  // attributes.
  transformProps: (_id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__ || props?.mounts === undefined) return props;
      const mounts: DiskMount[] = [];
      for (const mount of props.mounts as DiskMount[]) {
        mounts.push(
          Effect.isEffect(mount.disk)
            ? { ...mount, disk: yield* mount.disk as Effect.Effect<Disk, never, Providers> }
            : mount,
        );
      }
      return { ...props, mounts };
    }),
});

/**
 * Map a sandbox and its exposed ports to attributes. Archil lists port
 * hostnames separately; sandbox responses don't carry them. `program` is
 * the port and code of the program the sandbox runs, if any.
 */
export const toSandboxAttributes = (
  sandbox: archil.Sandbox,
  ports: ReadonlyArray<{ port: number; hostname: string }>,
  program?: { readonly port: number; readonly code: { hash: string } },
  derivedImage?: { readonly imageId: string; readonly hash: string },
): SandboxAttributes => {
  const endpoints = ports.map((e) => ({ port: e.port, hostname: e.hostname }));
  const primary = (program && endpoints.find((e) => e.port === program.port)) ?? endpoints[0];
  return {
    sandboxId: sandbox.sandbox_id,
    name: sandbox.name,
    status: sandbox.status,
    baseImage: sandbox.base_image,
    imageDigest: sandbox.image_digest,
    vcpuCount: sandbox.vcpu_count,
    memSizeMiB: sandbox.mem_size_mib,
    endpoints,
    url: primary ? `https://${primary.hostname}` : undefined,
    port: program?.port,
    code: program?.code,
    derivedImage: derivedImage && { imageId: derivedImage.imageId, hash: derivedImage.hash },
    setupHash: undefined,
  };
};

/** Read a sandbox's exposed ports and map it to attributes. */
export const observeSandbox = Effect.fn(function* (
  sandbox: archil.Sandbox,
  program?: { readonly port: number; readonly code: { hash: string } },
  derivedImage?: { readonly imageId: string; readonly hash: string },
) {
  const ports = yield* archil.listSandboxPorts({ sid: sandbox.sandbox_id }).pipe(
    Effect.map(({ data }) => data.ports ?? []),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
  return toSandboxAttributes(sandbox, ports, program, derivedImage);
});

/** The create request for sandbox props, with mounts already on the wire. */
export const toCreateSandboxRequest = (
  name: string | undefined,
  props: Omit<SandboxProps, "name" | "mounts">,
  mounts: ReadonlyArray<archil.SandboxMount> | undefined,
): archil.CreateSandboxRequest => ({
  wait: true,
  name,
  image_id: props.image,
  base_image: props.image ? undefined : props.baseImage,
  vcpu_count: props.vcpuCount,
  mem_size_mib: props.memSizeMiB,
  ports: props.ports,
  enable_service_ingress: props.enableServiceIngress,
  env: toEnv(props.env),
  network: props.network?.egress ? { egress: toEgressPolicy(props.network.egress) } : undefined,
  mounts: mounts && mounts.length > 0 ? [...mounts] : undefined,
  max_ttl_seconds: props.maxTtlSeconds,
  idle_ttl_seconds: props.idleTtlSeconds,
  max_concurrent_execs: props.maxConcurrentExecs,
});

/** Stop a live sandbox and wait until it has stopped. */
const stopSandbox = Effect.fn(function* (sid: string) {
  const observed = yield* getSandbox(sid);
  if (observed === undefined || deletableSandboxStates.has(observed.status)) return;
  // Let a booting or pausing sandbox settle, then stop it.
  yield* waitForSandbox(sid).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  yield* archil.stopSandbox({ sid }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );
  yield* waitForSandboxStopped(sid);
});

/**
 * Delete a sandbox and wait until it is gone. Archil only deletes stopped,
 * exited or failed sandboxes, so a live one is stopped first. Deleting a
 * missing sandbox succeeds.
 */
export const deleteSandbox = Effect.fn(function* (sid: string) {
  const observed = yield* getSandbox(sid);
  if (observed === undefined) return;
  yield* stopSandbox(sid);
  yield* archil.deleteSandbox({ sid }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );
  yield* waitForSandboxGone(sid);
});

/**
 * Wire mounts for a list of entries whose disks resolved to attributes or
 * handles. Fails when a disk has no id yet.
 */
export const toSandboxMounts = Effect.fn(function* (
  owner: string,
  mounts: ReadonlyArray<DiskMount>,
) {
  const wire: archil.SandboxMount[] = [];
  for (const mount of mounts) {
    const diskId = mountDiskId(mount.disk);
    if (diskId === undefined) {
      return yield* new MountDiskUnresolved({
        path: mount.path,
        message: `${owner}: the disk mounted at ${mount.path} has no diskId. Pass an Archil.Disk or a DiskHandle.`,
      });
    }
    wire.push(yield* toSandboxMount(diskId, mount));
  }
  return wire;
});

const activeBindings = (bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>) =>
  bindings.filter(
    (b: ResourceBinding<SandboxBinding> & { action?: string }) => b.action !== "delete",
  );

/** The sandbox's mounts: the props' entries, then the ones bindings add. */
const desiredMounts = Effect.fn(function* (
  id: string,
  mounts: ReadonlyArray<DiskMount> | undefined,
  bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>,
) {
  const wire = yield* toSandboxMounts(`Archil.Sandbox ${id}`, mounts ?? []);
  for (const binding of activeBindings(bindings)) {
    for (const mount of binding.data?.mounts ?? []) {
      if (!isCapability(mount)) wire.push(yield* toSandboxMount(mount.diskId, mount));
    }
  }
  // A binding and the props can name the same mount; keep one.
  const seen = new Set<string>();
  return wire.filter((mount) => {
    const key = JSON.stringify(mountIdentity(mount));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const isCapability = (mount: SandboxMountBinding | MountCapability): mount is MountCapability =>
  "install" in mount;

/** The filesystem clients bindings install into the sandbox's image. */
const boundCapabilities = (bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>) =>
  collectMountCapabilities(
    activeBindings(bindings).map((b) => ({
      data: { mounts: (b.data?.mounts ?? []).filter(isCapability) },
    })),
  );

/** The reference a derived image builds on: the `image`'s source, or `baseImage`. */
const baseReference = Effect.fn(function* (props: SandboxProps) {
  if (props.image === undefined) return props.baseImage ?? "node:24-bookworm";
  const { data } = yield* archil.getImage({ image_id: props.image });
  return data.canonical_source ?? data.source;
});

/**
 * The plan for a sandbox's derived image: its base plus the install lines
 * of the capabilities bound onto it. `undefined` when nothing is bound, so
 * the sandbox boots its base directly. Archil sandboxes run as root with
 * `/dev/fuse` and NFS, so every requirement is met.
 */
const planDerivedImage = Effect.fn(function* (
  id: string,
  props: SandboxProps,
  capabilities: ReadonlyArray<MountCapability>,
) {
  if (capabilities.length === 0) return undefined;
  const unsupported = checkMountSupport(`Archil.Sandbox ${id}`, capabilities, {
    fuse: true,
    nfs: true,
  });
  if (unsupported) return yield* unsupported;
  return yield* BuildPlan.plan(
    { image: yield* baseReference(props) },
    { capabilities: imageCapabilities, install: mountInstallLines(capabilities) },
  );
});

/** Build, push and pull a derived image, or keep the one `output` already has. */
const ensureDerivedImage = Effect.fn(function* (
  id: string,
  plan: BuildPlan.BuildPlan,
  push: ImagePush | undefined,
  existing: { readonly imageId: string; readonly hash: string } | undefined,
) {
  if (existing?.hash === plan.hash) return existing;
  if (push === undefined) {
    return yield* new ImageRequiresBuild({
      message: `Archil.Sandbox ${id}: a binding installs a filesystem client into its image, so Alchemy has to build one. Set \`push: { repository, credentials }\` for Archil to pull it from.`,
    });
  }
  const published = yield* publishPlan(plan, push);
  const image = yield* pullImage(published.source, published.credentials, plan.hash);
  return { imageId: image.imageId, hash: plan.hash };
});

const sortedMounts = (mounts: ReadonlyArray<archil.SandboxMount>) =>
  mounts.map(mountIdentity).sort((a, b) => a.path.localeCompare(b.path));

/**
 * Converge a sandbox's mounts. Archil only changes mounts when a stopped
 * sandbox starts, so a change stops it and starts it with the new ones;
 * its root filesystem is kept.
 */
const syncMounts = Effect.fn(function* (
  sandbox: archil.Sandbox,
  desired: ReadonlyArray<archil.SandboxMount>,
) {
  if (deepEqual(sortedMounts(sandbox.mounts ?? []), sortedMounts(desired))) return false;
  const sid = sandbox.sandbox_id;
  yield* stopSandbox(sid);
  yield* archil.startSandbox({ sid, wait: true, mounts: [...desired] });
  return true;
});

/** Converge a sandbox's exposed ports. */
const syncPorts = Effect.fn(function* (sid: string, desired: number[] | undefined) {
  if (desired === undefined) return;
  const { data } = yield* archil.listSandboxPorts({ sid });
  const observed = new Set((data.ports ?? []).map((p) => p.port));
  const want = new Set(desired);
  for (const port of want) {
    if (!observed.has(port)) yield* archil.exposeSandboxPort({ sid, port });
  }
  for (const port of observed) {
    if (!want.has(port)) yield* archil.deleteSandboxPort({ sid, port });
  }
});

/** Converge a sandbox's egress policy. */
const syncNetwork = Effect.fn(function* (sid: string, egress: SandboxEgress | undefined) {
  if (egress === undefined) return;
  const desired = toEgressPolicy(egress);
  const { data } = yield* archil.getSandboxNetwork({ sid });
  const { managed, policy } = splitArchilEgress(data.egress);
  if (!deepEqual(policy, desired)) {
    yield* archil.updateSandboxNetwork({
      sid,
      egress: { ...desired, allow: [...(desired.allow ?? []), ...managed] },
    });
  }
});

/** Props that can't change on a running sandbox. */
const createOnly = (props: SandboxProps | undefined) => ({
  image: props?.image,
  baseImage: props?.baseImage,
  vcpuCount: props?.vcpuCount,
  memSizeMiB: props?.memSizeMiB,
  enableServiceIngress: props?.enableServiceIngress,
  // A program's environment is the program's: it restarts, the box stays.
  env: props?.main === undefined ? toEnv(props?.env) : undefined,
  maxTtlSeconds: props?.maxTtlSeconds,
  maxConcurrentExecs: props?.maxConcurrentExecs,
  run: props?.run ?? [],
});

/** Exclusive mounts in props whose disks are known: one sandbox at a time holds each. */
const exclusiveDisks = (props: SandboxProps | undefined) =>
  new Set(
    (props?.mounts ?? [])
      .filter((m) => (m.mode ?? "exclusive") === "exclusive")
      .map((m) => mountDiskId(m.disk))
      .filter((id) => id !== undefined),
  );

const DEFAULT_PORT = 3000;

/** The name of the program's service inside its sandbox. */
const PROGRAM = "program";

/** The public hostname of `port`, exposing it when it isn't yet. */
const exposePort = Effect.fn(function* (sid: string, port: number) {
  const { data } = yield* archil.listSandboxPorts({ sid });
  const existing = (data.ports ?? []).find((p) => p.port === port);
  if (existing) return existing.hostname;
  const { data: exposed } = yield* archil.exposeSandboxPort({ sid, port });
  return exposed.hostname;
});

export const SandboxProvider = () =>
  Provider.effect(
    Sandbox,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
        HOST: "0.0.0.0",
      };
      return Sandbox.Provider.of({
        stables: ["sandboxId", "name"],
        nuke: { dependsOn: ["Archil.Disk"] },
        list: Effect.fn(function* () {
          return (yield* listSandboxes())
            .filter(
              (s) =>
                (isAlchemyName(s.name) || isRuntimeObjectName(s.name)) && s.status !== "deleted",
            )
            .map((sandbox) => toSandboxAttributes(sandbox, []));
        }),
        diff: Effect.fn(function* ({ id, olds, news, output, newBindings }) {
          if (!isResolved(news)) {
            // A program class's props hold its implementation (`exports`),
            // unresolved at plan. The bundle depends only on `main`,
            // `handler` and `build`, which are plain, so a code change still
            // redeploys the program in place.
            const program = news as SandboxProps;
            if (typeof program.main === "string" && output !== undefined) {
              const { hash } = yield* bundleProgram(
                program as SandboxProps & { main: string },
                virtualEntryPlugin,
              );
              if (hash !== output.code?.hash) return { action: "update" } as const;
            }
            return undefined;
          }
          const name = output?.name ?? (yield* sandboxName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) {
            return { action: "replace" } as const;
          }
          if (olds !== undefined && !deepEqual(createOnly(news), createOnly(olds))) {
            // A disk mounted for exclusive writes can only be held by one
            // sandbox, so the old one has to let go before the new one boots.
            const held = exclusiveDisks(olds);
            const deleteFirst = [...exclusiveDisks(news)].some((d) => held.has(d));
            return { action: "replace", deleteFirst } as const;
          }
          // A new set of installed clients builds a new image: a new sandbox.
          if (output !== undefined && isResolved(newBindings)) {
            const plan = yield* planDerivedImage(
              id,
              news,
              boundCapabilities(newBindings as ReadonlyArray<ResourceBinding<SandboxBinding>>),
            );
            if (plan?.hash !== output.derivedImage?.hash) {
              const held = exclusiveDisks(olds);
              const deleteFirst = [...exclusiveDisks(news)].some((d) => held.has(d));
              return { action: "replace", deleteFirst } as const;
            }
          }
          if (news.main !== undefined) {
            const { hash } = yield* bundleProgram(
              news as SandboxProps & { main: string },
              virtualEntryPlugin,
            );
            if (hash !== output?.code?.hash || (news.port ?? DEFAULT_PORT) !== output?.port) {
              return { action: "update" } as const;
            }
          } else if (output?.code !== undefined) {
            return { action: "update" } as const;
          }
          if (
            !deepEqual(egressIdentity(news.network?.egress), egressIdentity(olds?.network?.egress))
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name }) {
          const sandbox = yield* findSandboxByName(name);
          return sandbox ? yield* observeSandbox(sandbox) : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* sandboxName(id, olds?.name));
          const sandbox =
            (output ? yield* getSandbox(output.sandboxId) : undefined) ??
            (yield* findSandboxByName(name));
          if (!sandbox) return undefined;
          const program =
            output?.port !== undefined && output.code !== undefined
              ? { port: output.port, code: output.code }
              : undefined;
          const attrs = {
            ...(yield* observeSandbox(sandbox, program, output?.derivedImage)),
            setupHash: output?.setupHash,
          };
          if (output === undefined && olds?.name !== undefined && !isAlchemyName(sandbox.name)) {
            return Unowned(attrs);
          }
          return attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
          const name = output?.name ?? (yield* sandboxName(id, news.name));
          const mounts = yield* desiredMounts(id, news.mounts, bindings);
          const capabilities = boundCapabilities(bindings);
          const hosted = news.main !== undefined;
          // Observe
          let sandbox =
            (output ? yield* getSandbox(output.sandboxId) : undefined) ??
            (yield* findSandboxByName(name));
          // Ensure
          const derivedPlan = yield* planDerivedImage(id, news, capabilities);
          let derivedImage = output?.derivedImage;
          if (derivedPlan !== undefined) {
            if (derivedPlan.hash !== derivedImage?.hash) {
              yield* session.note(`Building the image for sandbox ${name}...`);
            }
            derivedImage = yield* ensureDerivedImage(id, derivedPlan, news.push, derivedImage);
          } else {
            derivedImage = undefined;
          }
          if (!sandbox) {
            yield* session.note(`Creating sandbox ${name}...`);
            const request = toCreateSandboxRequest(
              name,
              {
                ...news,
                image: derivedImage?.imageId ?? news.image,
                env: hosted ? undefined : news.env,
              },
              mounts,
            );
            sandbox = yield* archil.createSandbox(request).pipe(
              Effect.map(({ data }) => data),
              Effect.catchTag("SandboxNameConflict", (conflict) =>
                findSandboxByName(name).pipe(
                  Effect.flatMap((found) =>
                    found ? Effect.succeed(found) : Effect.fail(conflict),
                  ),
                ),
              ),
            );
          }
          const sid = sandbox.sandbox_id;
          sandbox = yield* waitForSandbox(sid);
          // Sync
          if (yield* syncMounts(sandbox, mounts)) {
            yield* session.note(`Remounted disks on sandbox ${name}`);
            sandbox = yield* waitForSandbox(sid);
          }
          yield* syncNetwork(sid, news.network?.egress);
          const port = news.port ?? DEFAULT_PORT;
          yield* syncPorts(
            sid,
            news.ports === undefined ? undefined : hosted ? [...news.ports, port] : news.ports,
          );
          if (
            news.idleTtlSeconds !== undefined &&
            news.idleTtlSeconds !== sandbox.idle_ttl_seconds
          ) {
            yield* archil.setSandboxTimeout({ sid, idle_ttl_seconds: news.idleTtlSeconds });
          }
          // Setup: run once, on the sandbox as created. A change replaces the
          // sandbox (see `createOnly`), so the commands always start clean.
          const run = news.run ?? [];
          const setupHash = run.length > 0 ? yield* sha256Object(run) : undefined;
          if (setupHash !== undefined && setupHash !== output?.setupHash) {
            for (const command of run) {
              yield* session.note(`Running \`${command}\` in sandbox ${name}...`);
              const result = yield* Process.exec(sid, command);
              if (result.exitCode !== 0) {
                return yield* new SandboxSetupFailed({
                  sandbox: name,
                  command,
                  exitCode: result.exitCode ?? -1,
                  stderr: result.stderr,
                });
              }
            }
            // Flush to disk, so a fork or a cold start sees what the commands wrote.
            yield* Process.exec(sid, "sync");
          }
          let program: { port: number; code: { hash: string } } | undefined;
          if (hosted) {
            const bindingEnv = activeBindings(bindings).reduce<Record<string, unknown>>(
              (acc, b) => ({ ...acc, ...b.data?.env }),
              {},
            );
            const bundled = yield* bundleProgram(
              news as SandboxProps & { main: string },
              virtualEntryPlugin,
            );
            // A moved port leaves the old one exposed; take it down.
            if (output?.port !== undefined && output.port !== port) {
              yield* archil
                .deleteSandboxPort({ sid, port: output.port })
                .pipe(Effect.catchTag("NotFound", () => Effect.void));
            }
            yield* deployProgram({
              sid,
              name: PROGRAM,
              port,
              program: bundled,
              env: { ...mountEnv(capabilities), ...bindingEnv, ...alchemyEnv, ...news.env },
            });
            yield* exposePort(sid, port);
            program = { port, code: { hash: bundled.hash } };
          } else if (output?.code !== undefined) {
            // `main` was removed: the box stays, the program goes.
            yield* removeProgram(sid, PROGRAM);
            if (output.port !== undefined && !(news.ports ?? []).includes(output.port)) {
              yield* archil
                .deleteSandboxPort({ sid, port: output.port })
                .pipe(Effect.catchTag("NotFound", () => Effect.void));
            }
          }
          // Return
          const final = yield* getSandbox(sid);
          return { ...(yield* observeSandbox(final ?? sandbox, program, derivedImage)), setupHash };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSandbox(output.sandboxId);
        }),
      });
    }),
  );
