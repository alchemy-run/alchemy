import type { ContainerImage } from "@distilled.cloud/cloudflare-runtime/Docker";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import {
  dockerBuild,
  materializeDockerfile,
  pushImage,
  writeContextFiles,
} from "../../Bundle/Docker.ts";
import { getStableContextDir } from "../../Bundle/TempRoot.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import {
  type Main,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import * as Server from "../../Server/index.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { isLiveId } from "../LocalRuntime.ts";
import { CloudflareLogs, type TelemetryFilter } from "../Logs.ts";
import type { Providers } from "../Providers.ts";
import { Container, ContainerTypeId } from "./Container.ts";
import {
  buildFinalDockerfile,
  bundleContainerProgram,
  createContainerApplicationName,
} from "./ContainerBundle.ts";
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
   * Main entrypoint for the container program. This file is bundled and
   * added to the Docker image as the container's entrypoint.
   */
  main?: string;
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
   * Inline Dockerfile used as the base for building the container image.
   * Alchemy appends statements to copy the bundled program and set the
   * entrypoint. If omitted, a default base image matching the runtime is used.
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
    dev: ContainerImage | undefined;
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

const resolveDurableObjectApplicationRecovery = ({
  namespaceId,
  expectedName,
  existingName,
}: {
  namespaceId: string;
  expectedName: string;
  existingName: string | undefined;
}) => {
  if (!existingName) {
    return {
      canAdopt: false as const,
      message: `Container application for Durable Object namespace "${namespaceId}" already exists but could not be found for adoption.`,
    };
  }
  if (existingName !== expectedName) {
    return {
      canAdopt: false as const,
      message: `Existing container application "${existingName}" is already attached to Durable Object namespace "${namespaceId}". Use that application name to adopt it.`,
    };
  }
  return {
    canAdopt: true as const,
  };
};

const containerApplicationReadinessSchedule = Schedule.exponential(150).pipe(
  Schedule.both(Schedule.recurs(10)),
);

const isContainerApplicationNotFound = (
  error: unknown,
): error is Containers.ContainerApplicationNotFound =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ContainerApplicationNotFound";

export const retryForContainerApplicationReadiness = <A, E, R>(
  operation: string,
  applicationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      isContainerApplicationNotFound(error)
        ? Effect.logDebug(
            `Cloudflare Container ${operation}: application ${applicationId} not found yet, retrying`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: isContainerApplicationNotFound,
      schedule: containerApplicationReadinessSchedule,
    }),
  );

export const ContainerProvider = () =>
  ProviderLayer.select({
    live: () => LiveContainerProvider(),
    local: () => LocalContainerProvider(),
  });

export const LiveContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const { dotAlchemy } = yield* AlchemyContext;

      const telemetry = yield* CloudflareLogs;

      const createApplicationName = createContainerApplicationName;

      const findApplicationByName = Effect.fnUntraced(function* (name: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.name === name)),
        );
      });

      const findApplicationByNamespace = Effect.fnUntraced(function* (
        namespaceId: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) =>
            apps.find((app) => app.durableObjects?.namespaceId === namespaceId),
          ),
        );
      });

      const desiredConfiguration = (
        props: ContainerApplicationProps,
        imageRef: string,
      ) =>
        normalizeNulls({
          image: imageRef,
          instanceType: props.instanceType,
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          disk: props.disk,
          environmentVariables: props.environmentVariables,
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      const computeImageHash = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
      ) {
        const main = props.main;
        if (!main) {
          return yield* Effect.fail(
            new Error("Container requires a `main` entrypoint."),
          );
        }
        const { accountId } = yield* yield* CloudflareEnvironment;

        const runtime = props.runtime ?? "bun";
        const { files, hash: bundleHash } = yield* bundleContainerProgram({
          id,
          main,
          runtime,
          handler: props.handler,
          isExternal: props.isExternal,
          external: props.external,
        });

        const finalDockerfile = buildFinalDockerfile(
          props.dockerfile,
          runtime,
          props.external,
          props.autoInstallExternals,
        );
        const imageHash = (yield* sha256Object({
          bundleHash,
          dockerfile: finalDockerfile,
        })).slice(0, 16);

        const name = yield* createApplicationName(id, props.name);
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const repositoryName = name.toLowerCase();
        const imageRef = `${registryId}/${accountId}/${repositoryName}:${imageHash}`;

        return { files, imageRef, imageHash };
      });

      const buildAndPushImage = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
        files: ReadonlyArray<{ path: string; content: Uint8Array }>,
        imageRef: string,
        session?: { note: (message: string) => Effect.Effect<void> },
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const runtime = props.runtime ?? "bun";

        yield* Effect.logInfo(
          `Cloudflare Container image: building ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Building container image ${imageRef}...`);
        }

        const contextDir = yield* getStableContextDir(
          process.cwd(),
          dotAlchemy,
          `${id}-container`,
        );
        const finalDockerfile = buildFinalDockerfile(
          props.dockerfile,
          runtime,
          props.external,
          props.autoInstallExternals,
        );
        yield* materializeDockerfile(finalDockerfile, contextDir);
        yield* writeContextFiles(
          contextDir,
          files.map((f, i) => ({
            // Keep the entry rename to `index.mjs` so the Dockerfile
            // ENTRYPOINT (`ENTRYPOINT ["bun", "/app/index.mjs"]`) stays
            // valid; preserve rolldown-assigned fileNames for every other
            // chunk so intra-bundle relative imports resolve at runtime.
            path: i === 0 ? "index.mjs" : f.path,
            content: f.content,
          })),
        );
        yield* dockerBuild({
          tag: imageRef,
          context: contextDir,
          platform: "linux/amd64",
        });

        yield* Effect.logInfo(
          `Cloudflare Container image: pushing ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Pushing container image ${imageRef}...`);
        }

        const registryId = props.registryId ?? "registry.cloudflare.com";
        const credentials =
          yield* Containers.createContainerRegistryCredentials({
            accountId,
            registryId,
            permissions: ["pull", "push"],
            expirationMinutes: 60,
          });
        const username = credentials.username ?? (credentials as any).user;
        if (!username) {
          return yield* Effect.fail(
            new Error(
              "Cloudflare registry credentials did not include a username.",
            ),
          );
        }

        yield* pushImage(imageRef, {
          username,
          password: credentials.password,
          server: registryId,
        });
      });

      const maybeCreateRollout = Effect.fnUntraced(function* ({
        applicationId,
        configuration,
        rollout,
      }: {
        applicationId: string;
        configuration: ContainerApplication.Configuration;
        rollout: ContainerApplication.Rollout | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const strategy = rollout?.strategy ?? "immediate";
        const stepPercentage =
          strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* retryForContainerApplicationReadiness(
          "rollout",
          applicationId,
          Containers.createContainerApplicationRollout({
            accountId,
            applicationId,
            description:
              strategy === "immediate"
                ? "Immediate update"
                : "Progressive update",
            strategy: "rolling",
            kind: rollout?.kind ?? "full_auto",
            stepPercentage,
            targetConfiguration: configuration,
          }),
        );
      });

      const createApplication = Effect.fnUntraced(function* ({
        id,
        news,
        name,
        configuration,
        durableObjects,
        session,
      }: {
        id: string;
        news: ContainerApplicationProps;
        name: string;
        configuration: ContainerApplication.Configuration;
        durableObjects:
          | {
              namespaceId: string;
            }
          | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const describeError = (error: unknown) => {
          if (error instanceof Error) {
            return JSON.stringify(
              Object.fromEntries(
                Object.getOwnPropertyNames(error).map((key) => [
                  key,
                  (error as unknown as Record<string, unknown>)[key],
                ]),
              ),
              null,
              2,
            );
          }
          return String(error);
        };

        // Engine has cleared us via `read` (foreign-named applications are
        // surfaced as `Unowned`). Re-fetch the existing application to fold
        // it into the upsert path.
        const existingByName = yield* findApplicationByName(name);

        if (existingByName) {
          yield* Effect.logInfo(
            `Cloudflare Container create: adopting existing application ${name}`,
          );
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existingByName),
            session,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container create: creating application ${name}`,
        );
        yield* session.note(`Creating container application ${name}...`);
        const adoptExistingByName = Effect.gen(function* () {
          yield* Effect.logInfo(
            `Cloudflare Container create: application ${name} already exists, adopting`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" already exists but could not be found for adoption.`,
              ),
            );
          }
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existing),
            session,
          });
        });

        const application = yield* Containers.createContainerApplication({
          accountId,
          name,
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          constraints: news.constraints ?? {},
          affinities: news.affinities,
          configuration,
          durableObjects,
        }).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", () =>
            durableObjects
              ? Effect.gen(function* () {
                  const existing = yield* findApplicationByNamespace(
                    durableObjects.namespaceId,
                  );
                  const recovery = resolveDurableObjectApplicationRecovery({
                    namespaceId: durableObjects.namespaceId,
                    expectedName: name,
                    existingName: existing?.name,
                  });
                  if (!recovery.canAdopt) {
                    return yield* Effect.fail(new Error(recovery.message));
                  }
                  if (!existing) {
                    return yield* Effect.fail(
                      new Error(
                        `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                      ),
                    );
                  }
                  return yield* upsertApplication({
                    id,
                    news,
                    existing: toAttributes(existing),
                    session,
                  });
                })
              : Effect.fail(
                  new Error(
                    "Durable Object namespace already has a container application. Set AdoptPolicy to adopt it.",
                  ),
                ),
          ),
          Effect.catchIf(
            (e) =>
              "message" in (e as any) &&
              String((e as any).message).includes("already exists"),
            () => adoptExistingByName,
          ),
          Effect.tapError((error) =>
            Effect.logError(
              `Cloudflare Container create error: ${describeError(error)}`,
            ),
          ),
        );

        return "applicationId" in application
          ? application
          : toAttributes(application);
      });

      const upsertApplication = Effect.fnUntraced(function* ({
        id,
        news,
        existing,
        session,
      }: {
        id: string;
        news: ContainerApplicationProps;
        existing: ContainerApplication["Attributes"];
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* Effect.logInfo(
          `Cloudflare Container update: preparing ${existing.applicationName}`,
        );
        const { files, imageRef, imageHash } = yield* computeImageHash(
          id,
          news,
        );
        const configuration = desiredConfiguration(news, imageRef);

        if (imageHash !== existing.hash?.image) {
          yield* buildAndPushImage(id, news, files, imageRef, session);
        }

        yield* session.note(
          `Updating container application ${existing.applicationName}...`,
        );
        const application = yield* retryForContainerApplicationReadiness(
          "update",
          existing.applicationId,
          Containers.updateContainerApplication({
            accountId,
            applicationId: existing.applicationId,
            instances: news.instances ?? 1,
            maxInstances: news.maxInstances ?? 1,
            schedulingPolicy: news.schedulingPolicy ?? "default",
            constraints: news.constraints ?? {},
            affinities: news.affinities,
            configuration,
          }),
        );
        const updated = toAttributes(application);
        if (!deepEqual(existing.configuration, configuration)) {
          yield* Effect.logInfo(
            `Cloudflare Container update: creating rollout for ${updated.applicationName}`,
          );
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration,
            rollout: news.rollout,
          });
        }
        return { ...updated, configuration, hash: { image: imageHash } };
      });

      const getDurableObjects = (
        bindings: ResourceBinding<ContainerApplication["Binding"]>[],
      ) => {
        const dos = bindings.flatMap((b) =>
          b.data.durableObjects ? [b.data.durableObjects] : [],
        );
        // A single DO namespace may appear in multiple bindings (e.g. when
        // a Container is referenced by several resources). Dedupe by namespaceId.
        const uniqueDos = dos.filter(
          (d, i, arr) =>
            arr.findIndex((other) => other.namespaceId === d.namespaceId) === i,
        );
        if (uniqueDos.length === 0) {
          return Effect.succeed(undefined);
        }
        if (uniqueDos.length === 1) {
          return Effect.succeed(uniqueDos[0]);
        }
        return Effect.die(
          new Error(
            `A Container can only be bound to one Durable Object namespace. Found ${uniqueDos.length} unique namespaces in bindings: ${uniqueDos.map((d) => d.namespaceId).join(", ")}`,
          ),
        );
      };

      return Container.Provider.of({
        stables: ["accountId", "applicationId"],
        diff: Effect.fnUntraced(function* ({
          id,
          olds = {},
          news = {},
          output,
          newBindings,
          oldBindings,
        }) {
          if (!isResolved(news) || !isResolved(newBindings)) {
            return undefined;
          }
          const { accountId } = yield* yield* CloudflareEnvironment;

          const name = yield* createApplicationName(id, news.name);
          const oldName = output?.applicationName
            ? output.applicationName
            : yield* createApplicationName(id, olds.name);

          if (
            (output?.accountId ?? accountId) !== accountId ||
            name !== oldName
          ) {
            return { action: "replace" } as const;
          }

          const hasDurableObjects =
            (yield* getDurableObjects(newBindings)) !== undefined;
          const hadDurableObjects =
            (yield* getDurableObjects(oldBindings)) !== undefined;
          if (hasDurableObjects !== hadDurableObjects) {
            return { action: "replace" } as const;
          }

          if (!output) {
            return undefined;
          }

          // A `dev:` applicationId means the resource only exists locally and
          // the real application has never been created. Promote it by forcing
          // an update so reconcile creates the live application.
          if (!isLiveId(output.applicationId)) {
            // Override stables to only include the accountId because the applicationId is going to change.
            return { action: "update", stables: ["accountId"] } as const;
          }

          const { imageHash } = yield* computeImageHash(id, news);
          if (imageHash !== output.hash?.image) {
            return { action: "update" } as const;
          }
        }),
        precreate: Effect.fnUntraced(function* ({ id, news = {}, session }) {
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(
            `Cloudflare Container precreate: starting ${name}`,
          );

          const { files, imageRef, imageHash } = yield* computeImageHash(
            id,
            news,
          );
          const configuration = desiredConfiguration(news, imageRef);
          yield* buildAndPushImage(id, news, files, imageRef, session);

          // Precreate intentionally omits the Durable Object attachment so the
          // worker can bind to this application id and break the circular
          // dependency. The final create step recreates the application with the
          // resolved namespace when needed.
          const result = yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects: undefined,
            session: {
              ...session,
              note: (message) =>
                session.note(message.replace("Creating", "Pre-creating")),
            },
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: { image: imageHash },
          };
        }),
        reconcile: Effect.fnUntraced(function* ({
          id,
          news = {},
          bindings,
          output,
          session,
        }) {
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(
            `Cloudflare Container reconcile: starting ${name}`,
          );
          const durableObjects = yield* getDurableObjects(bindings);
          const { files, imageRef, imageHash } = yield* computeImageHash(
            id,
            news,
          );
          const configuration = desiredConfiguration(news, imageRef);

          // Observe — re-fetch the cached application to confirm it still
          // exists. Cloudflare reports a deleted container application as
          // `ContainerApplicationNotFound`; we fall back to a name lookup
          // so we can recover from out-of-band deletes or partial state
          // persistence failures.
          let existing: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — skip the
          // cached-id fetch and fall through to the name lookup / create path
          // so we promote the local resource to a real application.
          if (output?.applicationId && isLiveId(output.applicationId)) {
            existing = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!existing) {
            const found = yield* findApplicationByName(name);
            if (found) {
              existing = {
                ...toAttributes(found),
                hash: output?.hash,
              };
            }
          }

          // Special case: precreate produced an application without the
          // durable object attachment, but the real reconcile now has one
          // (or vice versa). The DO attachment is immutable, so we delete
          // and recreate. Adoption-by-namespace is preferred when an app
          // already owns the namespace.
          if (existing && !deepEqual(existing.durableObjects, durableObjects)) {
            if (durableObjects) {
              const owner = yield* findApplicationByNamespace(
                durableObjects.namespaceId,
              );
              const recovery = resolveDurableObjectApplicationRecovery({
                namespaceId: durableObjects.namespaceId,
                expectedName: name,
                existingName: owner?.name,
              });
              if (recovery.canAdopt) {
                if (!owner) {
                  return yield* Effect.fail(
                    new Error(
                      `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                    ),
                  );
                }
                return yield* upsertApplication({
                  id,
                  news,
                  existing: toAttributes(owner),
                  session,
                });
              }
            }
            yield* Effect.logInfo(
              `Cloudflare Container reconcile: recreating ${name} to attach durable object binding`,
            );
            yield* session.note(
              `Recreating container application ${name} with durable object binding...`,
            );
            yield* Containers.deleteContainerApplication({
              accountId: existing.accountId,
              applicationId: existing.applicationId,
            }).pipe(
              Effect.catchTag(
                "ContainerApplicationNotFound",
                () => Effect.void,
              ),
            );
            if (imageHash !== existing.hash?.image) {
              yield* buildAndPushImage(id, news, files, imageRef, session);
            }
            const result = yield* createApplication({
              id,
              news,
              name,
              configuration,
              durableObjects,
              session,
            });
            return {
              ...("applicationId" in result ? result : toAttributes(result)),
              hash: { image: imageHash },
            };
          }

          // Sync — application exists with correct DO attachment. Apply
          // the desired configuration (image + scheduling + secrets, etc.)
          // through the upsert path, which builds and pushes the image
          // only when the hash changed and creates a rollout if the
          // configuration drifted.
          if (existing) {
            return yield* upsertApplication({
              id,
              news,
              existing,
              session,
            });
          }

          // Ensure — no application exists. Build and push the image,
          // then create. `createApplication` itself tolerates concurrent
          // creates by adopting an existing application with the same
          // name or namespace.
          yield* buildAndPushImage(id, news, files, imageRef, session);
          const result = yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects,
            session,
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: { image: imageHash },
          };
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          // A `dev:` applicationId only exists locally — there is no live
          // application to delete on Cloudflare.
          if (!isLiveId(output.applicationId)) return;
          yield* Effect.logInfo(
            `Cloudflare Container delete: deleting ${output.applicationName}`,
          );
          yield* Containers.deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          const readByName = (name: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container read: looking up ${name}`,
              );
              const existing = yield* findApplicationByName(name);
              if (!existing) {
                yield* Effect.logInfo(
                  `Cloudflare Container read: ${name} not found`,
                );
                return undefined;
              }
              return {
                ...toAttributes(existing),
                hash: output?.hash,
              };
            });

          let attrs: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — look the
          // application up by its (deterministic) name instead of hitting the
          // API with a fake id.
          if (output?.applicationId && !isLiveId(output.applicationId)) {
            return yield* readByName(output.applicationName);
          }
          if (output?.applicationId) {
            yield* Effect.logInfo(
              `Cloudflare Container read: checking ${output.applicationName}`,
            );
            attrs = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                readByName(output.applicationName),
              ),
            );
            // If we matched by id from prior state, treat as owned.
            return attrs;
          }

          const name = yield* createApplicationName(id, olds?.name);
          attrs = yield* readByName(name);
          if (!attrs) return undefined;
          // Cloudflare container applications carry no ownership signal that
          // we can read back from the API, so a name match is not proof of
          // ownership. Brand it `Unowned` so the engine surfaces
          // `OwnedBySomeoneElse` unless the caller opted in via `--adopt`.
          return Unowned(attrs);
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Account-scoped collection. `listContainerApplications` returns
            // the full application objects in one (non-paginated) response, so
            // each item already carries the complete `read` attributes shape —
            // no per-item hydration is required.
            return yield* Containers.listContainerApplications({
              accountId,
            }).pipe(
              Effect.map((apps) => apps.map((app) => toAttributes(app))),
              // Accounts without the containers product reject the route; treat
              // a non-entitled account as an empty collection rather than an
              // error.
              Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
            );
          }),
        tail: ({ output }) =>
          telemetry.tailStream({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
            options,
          }),
      });
    }),
  );

const containerFilters = (applicationId: string): TelemetryFilter[] => [
  {
    key: "$metadata.type",
    operation: "eq",
    type: "string",
    value: "cf-container",
  },
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: applicationId,
  },
];

const toAttributes = (
  application:
    | Containers.CreateContainerApplicationResponse
    | Containers.UpdateContainerApplicationResponse
    | Containers.GetContainerApplicationResponse
    | Containers.ListContainerApplicationsResponse[number],
): ContainerApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  schedulingPolicy: application.schedulingPolicy,
  instances: application.instances,
  maxInstances: application.maxInstances,
  constraints: normalizeNulls(
    application.constraints as ContainerApplication.Constraints | undefined,
  ),
  affinities: normalizeNulls(
    application.affinities as ContainerApplication.Affinities | undefined,
  ),
  configuration: normalizeNulls(
    application.configuration as ContainerApplication.Configuration,
  ),
  durableObjects: normalizeNulls(application.durableObjects) as
    | { namespaceId: string }
    | undefined,
  createdAt: application.createdAt,
  version: application.version,
  dev: undefined,
});
