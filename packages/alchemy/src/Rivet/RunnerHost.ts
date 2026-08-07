/**
 * The extension seam between the host-agnostic `rivet` worker engine and
 * the platform a **runner** (the container executing the user's actor
 * code) deploys to — the runner-side sibling of {@link ClusterHost}.
 *
 * Rivet inverts celld: nothing is uploaded to the engine, so deploying a
 * `Rivet.Worker` means building the user's `main` into a container image
 * and keeping N copies of it running with an outbound connection to the
 * engine. That build+run machinery is platform-specific (ECR + ECS for
 * AWS), so it lives behind this keyed seam — `Rivet.RunnerHost/<kind>` —
 * registered by cloud provider layers under the SAME kind as their
 * {@link ClusterHost} (`AWS.providers()` registers `aws-ecs` for both).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

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
  readonly connection: { readonly hostState?: Record<string, any> };
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

export interface RunnerHostService {
  readonly kind: "Rivet.RunnerHost";
  /**
   * Converge the runner deployment: bundle `main` with the generated entry,
   * build+push the image, and create/update the long-running compute.
   * Idempotent — crash mid-deploy, re-run, converge.
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

const RUNNER_HOST_PREFIX = "Rivet.RunnerHost/";

/**
 * The keyed Context tag for a Rivet runner host. Same kind → same tag, so
 * a layer built with `RunnerHost("aws-ecs")` is found by any dynamic
 * lookup for that kind.
 */
export const RunnerHost = (
  kind: string,
): Context.Service<RunnerHostService, RunnerHostService> =>
  Context.Service<RunnerHostService, RunnerHostService>()(
    `${RUNNER_HOST_PREFIX}${kind}`,
  ) as any;

/** Resolve the {@link RunnerHostService} for a host kind, or die with setup guidance. */
export const findRunnerHost = (
  kind: string | undefined,
): Effect.Effect<RunnerHostService> =>
  kind === undefined
    ? Effect.die(
        new Error(
          "This Rivet worker has no cluster host kind — declare the cluster " +
            "on the target: Rivet.Worker({ cluster, main }).",
        ),
      )
    : Effect.serviceOption(RunnerHost(kind)).pipe(
        Effect.flatMap((option) =>
          option._tag === "Some"
            ? Effect.succeed(option.value)
            : Effect.die(
                new Error(
                  `No Rivet runner host is registered for kind '${kind}'. ` +
                    "Add the provider layer that contributes it to the " +
                    "stack's providers — e.g. 'aws-ecs' ships with " +
                    "`AWS.providers()`.",
                ),
              ),
        ),
      );
