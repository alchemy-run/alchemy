import type { ContainerImage } from "@distilled.cloud/cloudflare-runtime/Docker";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import {
  type Main,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import { Resource } from "../../Resource.ts";
import * as Server from "../../Server/index.ts";
import type { Providers } from "../Providers.ts";
import { ContainerTypeId } from "./Container.ts";
import { LiveContainerProvider } from "./ContainerProvider.ts";
import { LocalContainerProvider } from "./LocalContainerProvider.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export namespace ContainerApplication {
  export type InstanceType = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["instanceType"]
  >;
  export type SchedulingPolicy = NonNullable<
    Containers.CreateContainerApplicationRequest["schedulingPolicy"]
  >;
  export type Observability = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["observability"]
  >;
  export type Secret = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["secrets"]
  >[number];
  export type Disk = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["disk"]
  >;
  export type EnvironmentVariable = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["environmentVariables"]
  >[number];
  export type Label = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["labels"]
  >[number];
  export type Network = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["network"]
  >;
  export type Dns = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["dns"]
  >;
  export type Port = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["ports"]
  >[number];
  export type Check = NonNullable<
    Containers.CreateContainerApplicationRequest["configuration"]["checks"]
  >[number];
  export type Constraints = {
    tier?: number;
  };
  export type Affinities = {
    colocation?: "datacenter";
  };
  export type Configuration =
    Containers.CreateContainerApplicationRequest["configuration"];
  export interface Rollout {
    strategy?: "rolling" | "immediate";
    kind?: "full_auto";
    stepPercentage?: number;
  }
}

export interface ContainerApplicationProps extends PlatformProps {
  /**
   * Main entrypoint for an Effect-native container program. This file is
   * bundled and added to a generated Docker image as the container's
   * entrypoint.
   *
   * The image source is selected by which of these props are set, in order:
   *
   * 1. {@link main} — bundle the Effect program and build a generated image.
   * 2. {@link image} — pull the given remote image and re-push it to
   *    Cloudflare's registry (no build).
   * 3. {@link context} / {@link dockerfile} — build the user's own Dockerfile
   *    against a build context directory.
   */
  main?: string;
  /**
   * A pre-built remote image to deploy, e.g. `ghcr.io/alpine/alpine:latest`.
   *
   * When set (and {@link main} is not), Alchemy pulls this image and re-pushes
   * it to Cloudflare's managed registry instead of building anything.
   */
  image?: string;
  /**
   * Build context directory used when building the container from a user
   * Dockerfile (i.e. when neither {@link main} nor {@link image} is set).
   *
   * @default `.`
   */
  context?: string;
  /**
   * Exported handler symbol inside the bundled module.
   * @default "default"
   */
  handler?: string;
  /**
   * Runtime environment for the container program.
   *
   * @default "bun"
   */
  runtime?: "bun" | "node";
  /**
   * Module specifiers that Rolldown should mark as external when bundling
   * the container entrypoint. The matching packages are installed inside the
   * image via the runtime's package manager (`bun add` for `runtime: "bun"`,
   * `npm install` for `runtime: "node"`) before the entrypoint runs.
   *
   * Use this for native dependencies that must not be bundled (e.g. `sharp`,
   * `impit`) or for packages that intentionally ship in the base image.
   *
   * Install inside the image is controlled by {@link autoInstallExternals}
   * (default `true`); set it to `false` if your custom `dockerfile` already
   * installs these packages and you want to avoid the redundant step.
   */
  external?: string[];
  /**
   * Whether to auto-install the packages listed in {@link external} inside
   * the container image (via `bun add` or `npm install`) before running the
   * entrypoint.
   *
   * @default true
   *
   * Set to `false` when your custom `dockerfile` already installs these
   * packages (for example, via a base image that pre-installs `sharp`), to
   * avoid the redundant install step.
   */
  autoInstallExternals?: boolean;
  /**
   * Human-readable application name. If omitted, Alchemy derives a deterministic
   * physical name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Dockerfile used to build the container image. Its meaning depends on the
   * selected variant:
   *
   * - With {@link main}: an inline Dockerfile string used as the base image.
   *   Alchemy appends statements to copy the bundled program and set the
   *   entrypoint. If omitted, a default base image matching the runtime is used.
   * - Without {@link main} (and without {@link image}): a path to the
   *   Dockerfile to build, resolved relative to {@link context}.
   *
   * @default `<context>/Dockerfile` for the user-Dockerfile variant.
   */
  dockerfile?: string;
  /**
   * Initial number of instances to maintain.
   * @default 1
   */
  instances?: number;
  /**
   * Maximum number of instances the application may scale to.
   * @default 1
   */
  maxInstances?: number;
  /**
   * Scheduling policy used by Cloudflare's containers control plane.
   * @default "default"
   */
  schedulingPolicy?: ContainerApplication.SchedulingPolicy;
  /**
   * Instance type for each deployment.
   * @default "dev"
   */
  instanceType?: ContainerApplication.InstanceType;
  /**
   * Observability settings for the deployment.
   */
  observability?: ContainerApplication.Observability;
  /**
   * SSH public keys to install into the deployment.
   */
  sshPublicKeyIds?: string[];
  /**
   * Secrets exposed to the container runtime as environment variables.
   */
  secrets?: ContainerApplication.Secret[];
  /**
   * CPU allocation override for each deployment.
   */
  vcpu?: number;
  /**
   * Memory allocation override for each deployment.
   */
  memory?: string;
  /**
   * Disk allocation override for each deployment.
   */
  disk?: ContainerApplication.Disk;
  /**
   * Plain environment variables passed to the container runtime.
   */
  environmentVariables?: ContainerApplication.EnvironmentVariable[];
  /**
   * Labels attached to the deployment.
   */
  labels?: ContainerApplication.Label[];
  /**
   * Network configuration for the deployment.
   */
  network?: ContainerApplication.Network;
  /**
   * Command override for the container image.
   */
  command?: string[];
  /**
   * Entrypoint override for the container image.
   */
  entrypoint?: string[];
  /**
   * DNS configuration for the deployment.
   */
  dns?: ContainerApplication.Dns;
  /**
   * Exposed ports for the deployment.
   */
  ports?: ContainerApplication.Port[];
  /**
   * Health and readiness checks for the deployment.
   */
  checks?: ContainerApplication.Check[];
  /**
   * Resource constraints for the application.
   */
  constraints?: ContainerApplication.Constraints;
  /**
   * Affinity hints for scheduling.
   */
  affinities?: ContainerApplication.Affinities;
  /**
   * Progressive rollout settings applied after updates.
   */
  rollout?: ContainerApplication.Rollout;
  /**
   * Container registry host to use for generated Dockerfile builds.
   * @default "registry.cloudflare.com"
   */
  registryId?: string;
  /**
   * Environment variables passed to the container runtime.
   */
  env?: Record<string, any>;
  /**
   * Exports passed to the container runtime.
   */
  exports?: string[];
}

export type ContainerServices =
  | ContainerApplication
  | PlatformServices
  | Server.ProcessServices;

export type ContainerShape = Main<ContainerServices>;

/**
 * A Cloudflare Container Application — the deployed, scalable unit that runs a
 * containerized program on Cloudflare's compute platform. Alchemy bundles the
 * `main` entrypoint, builds a Docker image, pushes it to the Cloudflare
 * registry, and reconciles the application's scaling and runtime configuration.
 *
 * This is the lower-level resource backing the {@link Container} platform
 * binding; in application code you typically extend `Cloudflare.Container` to
 * define and bind a container to a Durable Object rather than referencing this
 * resource directly. The same props shape (`main`, `instanceType`, `instances`,
 * etc.) is accepted by the `Cloudflare.Container(...)` class form shown below.
 *
 * @resource
 * @product Containers
 * @category Workers & Compute
 * @internal
 * @section Defining a Container Application
 * Point `main` at the container's entrypoint file; Alchemy bundles it and uses
 * it as the image's entrypoint. The application name is derived deterministically
 * from the stack, stage, and logical ID unless you set an explicit `name`, and
 * `handler` selects which export to run when it isn't the default.
 *
 * @example Minimal container
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * export class Sandbox extends Cloudflare.Container<Sandbox>()("Sandbox", {
 *   main: import.meta.filename,
 * }) {}
 * ```
 *
 * The single `main` prop is enough to ship a container: Alchemy bundles the
 * entrypoint, builds and pushes the image, and provisions an application with
 * one instance. Reach for the other props only when you need to scale, expose
 * ports, or customize the build.
 *
 * @example Named container with a non-default handler export
 * ```typescript
 * export class Worker extends Cloudflare.Container<Worker>()("Worker", {
 *   main: import.meta.filename,
 *   handler: "runWorker",
 *   name: "background-worker",
 * }) {}
 * ```
 *
 * `name` pins a stable application name (instead of the generated one), which is
 * useful for adopting an existing application, while `handler` runs the named
 * `runWorker` export rather than the module's default.
 *
 * @section Image Sources
 * The image is resolved from exactly one of three props, checked in order:
 * `main` (bundle an Effect program into a generated image), then `image`
 * (pull and re-push a remote image), then `context` / `dockerfile` (build
 * your own Dockerfile). Only `main` injects an Effect runtime; the other two
 * ship an arbitrary image unchanged.
 *
 * @example Build your own Dockerfile (`context` / `dockerfile`)
 * ```typescript
 * export class Web extends Cloudflare.Container<Web>()("Web", {
 *   context: `${import.meta.dirname}/context`,
 *   dockerfile: "Dockerfile",
 * }) {}
 * ```
 *
 * Alchemy builds `dockerfile` against the `context` directory with no `main`
 * bundling. `dockerfile` is resolved relative to `context` and defaults to
 * `<context>/Dockerfile`.
 *
 * @example Remote image (`image`)
 * ```typescript
 * export class Echo extends Cloudflare.Container<Echo>()("Echo", {
 *   image: "mendhak/http-https-echo:latest",
 * }) {}
 * ```
 *
 * Alchemy pulls the pre-built public image and re-pushes it to Cloudflare's
 * managed registry instead of building anything.
 *
 * @section Bundling & Dependencies
 * By default the entrypoint is bundled for the `bun` runtime. Use `runtime` to
 * switch to Node, `external` to keep native/precompiled packages out of the
 * bundle (auto-installed in the image unless `autoInstallExternals` is `false`),
 * a custom `dockerfile` as the image base, and `registryId` to override the
 * registry host.
 *
 * @example Node runtime with external native deps
 * ```typescript
 * export class ImageApi extends Cloudflare.Container<ImageApi>()("ImageApi", {
 *   main: import.meta.filename,
 *   runtime: "node",
 *   external: ["sharp"],
 *   autoInstallExternals: true,
 * }) {}
 * ```
 *
 * Marking `sharp` as `external` stops Rolldown from bundling the native module;
 * because `autoInstallExternals` is `true`, Alchemy runs `npm install sharp`
 * inside the image so the dependency is present at runtime.
 *
 * @example Custom Dockerfile base and registry
 * ```typescript
 * export class Custom extends Cloudflare.Container<Custom>()("Custom", {
 *   main: import.meta.filename,
 *   dockerfile: "FROM oven/bun:1\nRUN apt-get update && apt-get install -y ffmpeg",
 *   autoInstallExternals: false,
 *   registryId: "registry.cloudflare.com",
 * }) {}
 * ```
 *
 * Alchemy appends the program-copy and entrypoint steps to your `dockerfile`,
 * so you control the base image and any system packages; `autoInstallExternals:
 * false` skips the redundant install step when your Dockerfile already provides
 * those packages.
 *
 * @section Scaling & Instance Types
 * Control the desired and maximum instance counts with `instances`/`maxInstances`
 * and pick a compute size with `instanceType`. For finer control, override
 * `vcpu`, `memory`, and `disk` directly.
 *
 * @example Autoscaling with a larger instance type
 * ```typescript
 * export class Sandbox extends Cloudflare.Container<Sandbox>()("Sandbox", {
 *   main: import.meta.filename,
 *   instanceType: "standard-1",
 *   instances: 1,
 *   maxInstances: 5,
 * }) {}
 * ```
 *
 * The application keeps one instance running and may scale out to five under
 * load, each on the `standard-1` size. Use a larger `instanceType` (or the
 * explicit overrides below) when the default `dev` size is too small.
 *
 * @example Explicit CPU, memory, and disk overrides
 * ```typescript
 * export class Heavy extends Cloudflare.Container<Heavy>()("Heavy", {
 *   main: import.meta.filename,
 *   vcpu: 2,
 *   memory: "4GB",
 *   disk: { size: "10GB" },
 * }) {}
 * ```
 *
 * These props override the per-instance resource allocation independently of
 * `instanceType`, which is handy when a workload needs, say, extra disk for
 * scratch space without bumping every other dimension.
 *
 * @section Runtime Configuration
 * Inject configuration with `environmentVariables` (plain values) and `secrets`
 * (references to stored secrets), and override the image's `command` or
 * `entrypoint`. `labels` attach metadata to the deployment.
 *
 * @example Environment variables, secrets, and a command override
 * ```typescript
 * export class Api extends Cloudflare.Container<Api>()("Api", {
 *   main: import.meta.filename,
 *   environmentVariables: [{ name: "LOG_LEVEL", value: "info" }],
 *   secrets: [{ name: "API_KEY", type: "env", secret: "my-stored-secret" }],
 *   command: ["bun", "run", "start"],
 *   labels: [{ name: "team", value: "payments" }],
 * }) {}
 * ```
 *
 * `environmentVariables` are visible plain values, while `secrets` map a stored
 * secret into the runtime as an env var without exposing it in config; `command`
 * overrides the container's startup command and `labels` tag the deployment for
 * organization.
 *
 * @example Passing env and selecting runtime exports
 * ```typescript
 * export class Job extends Cloudflare.Container<Job>()("Job", {
 *   main: import.meta.filename,
 *   env: { REGION: "wnam", FEATURE_FLAG: "on" },
 *   exports: ["default"],
 * }) {}
 * ```
 *
 * `env` injects values into the bundled program's runtime context (as opposed to
 * the deployment-level `environmentVariables`), and `exports` declares which
 * symbols from the entrypoint module the runtime should wire up.
 *
 * @section Networking & Health Checks
 * Configure outbound/inbound networking with `network` and `dns`, expose
 * `ports`, and gate readiness with `checks`.
 *
 * @example Ports, network mode, DNS, and a health check
 * ```typescript
 * export class Web extends Cloudflare.Container<Web>()("Web", {
 *   main: import.meta.filename,
 *   ports: [{ name: "http", port: 8080 }],
 *   network: { assignIpv4: "predefined", mode: "public" },
 *   dns: { servers: ["1.1.1.1"], searches: ["internal"] },
 *   checks: [{ name: "ready", type: "http", port: "8080", tls: false }],
 * }) {}
 * ```
 *
 * `ports` publishes the named port the program listens on, `network` controls IP
 * assignment and public/private reachability, `dns` overrides resolver settings,
 * and `checks` tells Cloudflare how to probe the container before routing
 * traffic to it.
 *
 * @section Observability & Access
 * Turn on log shipping with `observability` and install `sshPublicKeyIds` for
 * interactive access to running instances.
 *
 * @example Enable logs and grant SSH access
 * ```typescript
 * export class Api extends Cloudflare.Container<Api>()("Api", {
 *   main: import.meta.filename,
 *   observability: { logs: { enabled: true } },
 *   sshPublicKeyIds: ["ssh-key-id-123"],
 * }) {}
 * ```
 *
 * `observability.logs.enabled` streams the container's logs into Cloudflare's
 * telemetry pipeline (queryable via the resource's `logs`/`tail` operations),
 * and `sshPublicKeyIds` authorizes the listed keys to connect to instances for
 * debugging.
 *
 * @section Scheduling & Placement
 * Influence where and how Cloudflare schedules instances with `schedulingPolicy`,
 * `constraints`, and `affinities`.
 *
 * @example Pin scheduling policy and placement
 * ```typescript
 * export class Edge extends Cloudflare.Container<Edge>()("Edge", {
 *   main: import.meta.filename,
 *   schedulingPolicy: "regional",
 *   constraints: { tier: 1 },
 *   affinities: { colocation: "datacenter" },
 * }) {}
 * ```
 *
 * `schedulingPolicy` selects the control-plane placement strategy,
 * `constraints.tier` restricts which capacity tier instances may land on, and
 * `affinities.colocation` keeps related instances in the same datacenter to
 * reduce inter-instance latency.
 *
 * @section Rollouts
 * When an update changes the configuration, `rollout` controls how the new
 * version is rolled out across instances.
 *
 * @example Progressive rollout on update
 * ```typescript
 * export class Api extends Cloudflare.Container<Api>()("Api", {
 *   main: import.meta.filename,
 *   instances: 4,
 *   maxInstances: 4,
 *   rollout: { strategy: "rolling", stepPercentage: 25 },
 * }) {}
 * ```
 *
 * A `rolling` strategy with `stepPercentage: 25` replaces instances in 25%
 * increments so the application stays available during the update; the default
 * `immediate` strategy swaps everything at once.
 */
export interface ContainerApplication<Shape = unknown> extends Resource<
  ContainerTypeId,
  ContainerApplicationProps,
  {
    /**
     * Cloudflare-assigned unique identifier of the container application.
     */
    applicationId: string;
    /**
     * The resolved application name (either the provided `name` or the
     * deterministic physical name derived from the stack, stage, and logical ID).
     */
    applicationName: string;
    /**
     * The Cloudflare account ID that owns the application.
     */
    accountId: string;
    /**
     * The scheduling policy in effect for the application's deployments.
     */
    schedulingPolicy: ContainerApplication.SchedulingPolicy;
    /**
     * The current desired number of instances.
     */
    instances: number;
    /**
     * The maximum number of instances the application may scale to.
     */
    maxInstances: number;
    /**
     * Resource constraints applied to the application, if any.
     */
    constraints: ContainerApplication.Constraints | undefined;
    /**
     * Scheduling affinity hints applied to the application, if any.
     */
    affinities: ContainerApplication.Affinities | undefined;
    /**
     * The resolved deployment configuration (image, networking, secrets, ports,
     * checks, etc.) currently applied to the application.
     */
    configuration: ContainerApplication.Configuration;
    /**
     * The Durable Object namespace attached to the application, if it is bound
     * to one.
     */
    durableObjects:
      | {
          namespaceId: string;
        }
      | undefined;
    /**
     * ISO-8601 timestamp of when the application was created.
     */
    createdAt: string;
    /**
     * The application's configuration version, incremented on each update.
     */
    version: number;
    /**
     * Internal cache of the built image hash, used to skip rebuilds when the
     * bundled program and Dockerfile are unchanged.
     */
    hash?: {
      image: string;
    };
    dev: DevContainerImage | undefined;
  },
  {
    /**
     * Durable Object namespace attached to the container application.
     */
    durableObjects?: {
      namespaceId: string;
    };
    /**
     * Environment variables injected into the container runtime via the binding.
     */
    env?: Record<string, any>;
  },
  Providers
> {
  /** @internal phantom */
  Shape: Shape;
}

// `DevContainerImage` stays here (consumed by the Attrs `dev` field above and
// imported by Worker.ts). The provider helpers that previously lived here
// (resolveDurableObjectApplicationRecovery, the readiness schedule/retry, etc.)
// were extracted to ContainerProvider.ts on this branch.
export type DevContainerImage = ContainerImage;

export const ContainerProvider = () =>
  ProviderLayer.select({
    live: () => LiveContainerProvider(),
    local: () => LocalContainerProvider(),
  });
