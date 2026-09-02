/**
 * The seam between the platform-agnostic `Rivet.*` resources and the
 * platform the Rivet **engine** and its **runners** run on: a plain
 * `Context.Service` a cloud provider implements as a Layer
 * ({@link ../Rivet/EcsHost.ts Rivet.Ecs} for AWS ECS) and the user merges
 * into the stack's providers alongside `Rivet.providers()`.
 *
 * A host owns everything platform-specific:
 *
 * - **compose** — plan-time composition of the engine's child resources
 *   (network, compute, discovery, admin token) for a {@link Cluster},
 *   returning the connection material the Cluster persists.
 * - **deployRunner** / **runnerCodeHash** / **deleteRunner** — the
 *   lifecycle of a {@link Worker}'s runner: the user's `main` bundled with
 *   the generated rivetkit entry, built into an image and kept running
 *   with an outbound connection to the engine.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import type { ClusterProps } from "./Cluster.ts";

/** Fargate CPU architecture of an engine or runner task. */
export type CpuArchitecture = "ARM64" | "X86_64";

/** The architecture engine and runner tasks run on unless a prop says otherwise. */
export const DEFAULT_CPU_ARCHITECTURE: CpuArchitecture = "X86_64";

export interface HostComposeOptions {
  /** The Cluster's logical id. */
  readonly id: string;
  /** The user-supplied Cluster props. */
  readonly props: ClusterProps;
}

/**
 * The connection material a host's `compose` hands back to the Cluster.
 * Values may be `Output`s of the composed child resources (`Input` accepts
 * both).
 */
export interface HostComposeResult {
  /** The HTTP endpoint callers reach the engine's guard service on. */
  readonly endpoint: Input<string>;
  /** The engine's admin token (`RIVET__AUTH__ADMIN_TOKEN`). */
  readonly adminToken: Input<Redacted.Redacted<string>>;
  /**
   * Host-specific state persisted on the Cluster's attributes and copied
   * onto every Worker deployed against it: the compute the runner joins
   * and the network attachment VPC-bound callers need (`subnetIds`,
   * `securityGroupIds`).
   */
  readonly hostState?: Record<string, Input<any>>;
}

/** The image source for a runner deployment (a `main`-rooted bundle). */
export interface RunnerSource {
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  readonly main: string;
  /** Bundler configuration overrides (platform `Bundle.BundleConfig`). */
  readonly build?: unknown;
  /**
   * Environment image the bundled runner is layered onto (must run bun).
   * @default "oven/bun:1"
   */
  readonly image?: string;
  /**
   * The rivetkit release installed into the runner image (kept external to
   * the bundle — it ships unbundleable wasm/napi sidecars).
   * @default DEFAULT_RIVETKIT_VERSION
   */
  readonly rivetkitVersion?: string;
  /** Runner task CPU units. @default 512 */
  readonly cpu?: number;
  /** Runner task memory (MiB). @default 1024 */
  readonly memory?: number;
  /** Number of runner instances. @default 1 */
  readonly desiredCount?: number;
  /** CPU architecture the runner image is built for and runs on. @default "X86_64" */
  readonly cpuArchitecture?: CpuArchitecture;
}

/** Physical names the engine computed for the runner's cloud resources. */
export interface RunnerNames {
  readonly serviceName: string;
  readonly repositoryName: string;
  readonly taskFamily: string;
  readonly taskRoleName: string;
  readonly executionRoleName: string;
  readonly logGroupName: string;
}

export interface RunnerDeployOptions {
  /** The worker's logical id. */
  readonly id: string;
  readonly names: RunnerNames;
  readonly source: RunnerSource;
  /** Fully-rendered container environment (RIVET_* + user env + bindings). */
  readonly env: Record<string, string>;
  /**
   * The virtual-entry bootstrap wrapped around `main`: receives the
   * resolved entry import path, returns the generated runner entry source
   * (see `RunnerEntry.ts`).
   */
  readonly bootstrap: (importPath: string) => string;
  /** The cluster's host state (compute + network attachment). */
  readonly hostState: Record<string, any> | undefined;
  /** Tags applied to created cloud resources. */
  readonly tags: Record<string, string>;
  /** The prior runner state (`output.runner`), when updating. */
  readonly output: Record<string, any> | undefined;
  readonly session: { note: (message: string) => Effect.Effect<void> };
}

export interface RunnerDeployResult {
  /** Content hash identifying the runner image (diff baseline). */
  readonly codeHash: string;
  /** Host-specific state persisted on the worker's attributes. */
  readonly runnerState: Record<string, any>;
}

export interface HostService {
  /**
   * Compose the engine's platform children for a Cluster and return the
   * connection material it persists.
   */
  readonly compose: (
    options: HostComposeOptions,
  ) => Effect.Effect<HostComposeResult, any, any>;
  /**
   * Converge a Worker's runner deployment: bundle `main` with the
   * generated entry, build+push the image, and create/update the
   * long-running compute. Idempotent — crash mid-deploy, re-run, converge.
   */
  readonly deployRunner: (
    options: RunnerDeployOptions,
  ) => Effect.Effect<RunnerDeployResult, any, any>;
  /**
   * The content hash `deployRunner` would push for this source (bundling
   * included, so bootstrap/template changes surface as drift). `undefined`
   * when not computable at plan time.
   */
  readonly runnerCodeHash: (options: {
    readonly source: RunnerSource;
    readonly bootstrap: (importPath: string) => string;
  }) => Effect.Effect<string | undefined, any, any>;
  /** Tear down everything `deployRunner` created. Idempotent. */
  readonly deleteRunner: (options: {
    readonly output: Record<string, any>;
  }) => Effect.Effect<void, any, any>;
}

/**
 * The Rivet host service. Provided by a cloud provider's Layer — merge one
 * into the stack's providers:
 *
 * ```ts
 * providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs())
 * ```
 */
export class Host extends Context.Service<Host, HostService>()("Rivet.Host") {}
