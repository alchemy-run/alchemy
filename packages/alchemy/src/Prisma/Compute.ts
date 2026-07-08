import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { findCwdForBundle } from "../Bundle/TempRoot.ts";
import { isResolved } from "../Diff.ts";
import { HttpServer, type HttpEffect } from "../Http.ts";
import type { InputProps } from "../Input.ts";
import * as Output from "../Output.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceBinding } from "../Resource.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import type * as Server from "../Server/index.ts";
import { Self } from "../Self.ts";
import { Stack } from "../Stack.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import {
  PrismaApiError,
  PrismaClient,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import {
  runBuildCommand,
  runComputeAutoBuild,
  type ComputeAutoBuildFramework,
} from "./ComputeBuild.ts";
import { createComputeArchive, normalizeEntrypoint } from "./ComputeArchive.ts";
import {
  destroyComputeService,
  destroyComputeVersion,
  isConflict,
  toDeploymentUrl,
  waitForComputeVersionStatus,
} from "./ComputeLifecycle.ts";
import {
  startComputeServiceVersionWithFallback,
  stopComputeServiceVersionWithFallback,
} from "./Internal/ComputeVersionActions.ts";
import { observeComputeVersion } from "./Internal/ComputeVersionObserve.ts";
import { tailComputeVersionLogs } from "./PrismaLogs.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type {
  ComputeService as ApiComputeService,
  ComputeVersion as ApiComputeVersion,
  EnvironmentVariable as ApiEnvironmentVariable,
  PrismaRegionId,
} from "./Types.ts";
import { readUploadArtifact, uploadArtifact } from "./ComputeVersion.ts";

type ObservedComputeVersion = Omit<ApiComputeVersion, "createdAt"> & {
  createdAt?: string;
};

const ComputeTypeId = "Prisma.Compute" as const;
type ComputeTypeId = typeof ComputeTypeId;

export interface ComputeCommandBuild {
  /**
   * Shell command that creates the deployable output directory.
   */
  command: string;
  /**
   * Working directory for the build command.
   *
   * @default path
   */
  cwd?: string;
  /**
   * Build output directory, relative to `cwd`.
   */
  outdir: string;
  /**
   * Entrypoint inside `outdir`.
   */
  entrypoint?: string;
  /**
   * Environment variables supplied to the build command.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface ComputeAutoBuild {
  /**
   * Auto-detect a Prisma Compute build strategy, or force one framework.
   */
  type: "auto";
  /**
   * Framework build strategy.
   *
   * @default "auto"
   */
  framework?: ComputeAutoBuildFramework;
  /**
   * Environment variables supplied to the build command.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export type ComputeBuild = ComputeCommandBuild | ComputeAutoBuild;

export interface ComputeBundleOptions {
  /**
   * Rolldown input options for effect-native Compute bundles.
   */
  input?: Partial<rolldown.InputOptions>;
  /**
   * Rolldown output options for effect-native Compute bundles.
   */
  output?: Partial<rolldown.OutputOptions>;
  /**
   * Additional Alchemy bundle options for effect-native Compute bundles.
   */
  extra?: Bundle.BundleExtraOptions;
}

export interface ComputeDev {
  /**
   * Local command to run during `alchemy dev`.
   */
  command?: string;
  /**
   * Working directory for the dev command.
   *
   * @default path
   */
  cwd?: string;
  /**
   * Local development port.
   */
  port?: number;
  /**
   * Explicit local URL to expose in the resource output.
   */
  url?: string;
  /**
   * Extra environment variables for the dev command.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface ComputeProps extends PlatformProps {
  /**
   * Project ID or `project.projectId` output that owns the compute service.
   */
  project: string | Project;
  /**
   * Compute service display name.
   */
  serviceName: string;
  /**
   * Region where the service is placed.
   *
   * @default "us-east-1"
   */
  regionId?: PrismaRegionId;
  /**
   * Branch ID to attach the service to. Mutually exclusive with branchGitName.
   * If both branch fields are omitted, Alchemy attaches to `main`.
   */
  branchId?: string | null;
  /**
   * Branch git name to attach the service to. Mutually exclusive with branchId.
   *
   * @default "main"
   */
  branchGitName?: string | null;
  /**
   * Application directory used for pre-built artifacts and build commands.
   *
   * @default "."
   */
  path?: string;
  /**
   * Entrypoint relative to the deployed artifact directory.
   * If omitted, Alchemy reads `package.json#main`.
   */
  entrypoint?: string;
  /**
   * Entry module for an effect-native Compute app.
   *
   * This is required when you pass an inline Effect implementation to
   * `Prisma.Compute`, and ignored for external path/artifact deployments.
   */
  main?: string;
  /**
   * Exported symbol inside `main` for effect-native Compute apps.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Bundler options for effect-native Compute apps.
   */
  bundle?: ComputeBundleOptions;
  /**
   * Effect-native runtime exports populated by the Platform constructor.
   *
   * @internal
   */
  exports?: string[] | Record<string, unknown>;
  /**
   * Build command and output directory. Set to `"auto"` or `{ type: "auto" }`
   * to use Prisma Compute-style framework detection for Next.js, Nuxt, Astro,
   * TanStack Start, or Bun. Set to `false` to upload `path` as a pre-built
   * artifact.
   */
  build?: ComputeBuild | false | "auto";
  /**
   * Pre-created `tar.gz` artifact bytes. When supplied, Alchemy uploads it
   * directly. Mutually exclusive with artifactPath.
   */
  artifact?: string | Uint8Array;
  /**
   * Path to a pre-created `tar.gz` artifact file. When supplied, Alchemy reads
   * and uploads it directly. Mutually exclusive with artifact.
   */
  artifactPath?: string;
  /**
   * HTTP port exposed by the application.
   *
   * @default 8080
   */
  port?: number;
  /**
   * Runtime environment variables to sync through Prisma's environment
   * variable API before creating a new compute version. Set a value to `null`
   * to delete that variable.
   */
  env?: Record<string, string | Redacted.Redacted<string> | null | undefined>;
  /**
   * Prisma environment variable class used by the `env` convenience property.
   *
   * @default "production"
   */
  envClass?: "production" | "preview";
  /**
   * Create the next version by reusing the previous code artifact.
   *
   * @default false
   */
  skipCodeUpload?: boolean;
  /**
   * Start the created/reused version.
   * Set `skipPromote: true` when disabling start.
   *
   * @default true
   */
  start?: boolean;
  /**
   * Do not promote the version to the stable service endpoint.
   *
   * @default false
   */
  skipPromote?: boolean;
  /**
   * Delete the previously promoted version after the new one is promoted.
   *
   * @default false
   */
  destroyOldVersion?: boolean;
  /**
   * Poll timeout while waiting for start/stop.
   *
   * @default 120
   */
  timeoutSeconds?: number;
  /**
   * Poll interval while waiting for start/stop.
   *
   * @default 1000
   */
  pollIntervalMs?: number;
  /**
   * Verify that Prisma's public preview/service URL has reached the edge after
   * the Management API reports the version as running.
   *
   * @default true
   */
  verifyUrl?: boolean;
  /**
   * Maximum time to wait for Prisma's public URL to stop returning the
   * platform-level "Service not found" page.
   *
   * @default 60
   */
  urlReadinessTimeoutSeconds?: number;
  /**
   * Local development behavior for `alchemy dev`.
   */
  dev?: ComputeDev;
}

export interface Compute extends Resource<
  ComputeTypeId,
  ComputeProps,
  {
    /**
     * Prisma compute service ID.
     */
    computeServiceId: string;
    /**
     * Prisma compute version ID created for the current deployment.
     */
    computeVersionId: string | undefined;
    /**
     * Project ID that owns the app.
     */
    projectId: string;
    /**
     * Compute service display name.
     */
    serviceName: string;
    /**
     * Region ID where the service is placed.
     */
    regionId: string;
    /**
     * Preview endpoint domain for the deployed version.
     */
    versionEndpointDomain: string | undefined;
    /**
     * HTTPS URL for the deployed version endpoint.
     */
    versionUrl: string | undefined;
    /**
     * Stable service endpoint domain after promotion.
     */
    serviceEndpointDomain: string | undefined;
    /**
     * Preferred URL for the app, local in dev or stable/preview in deploys.
     */
    url: string | undefined;
    /**
     * Whether the current version was promoted to the stable endpoint.
     */
    promoted: boolean;
    /**
     * Previously promoted version ID observed before deploy.
     */
    previousVersionId: string | null | undefined;
    /**
     * Action taken for the previous version.
     */
    previousVersionAction:
      | "stopped"
      | "destroyed"
      | "still-active"
      | null
      | undefined;
    /**
     * Environment variable keys managed by this Compute resource.
     *
     * This includes explicit `env` props and env vars added by bindings.
     */
    environmentKeys?: string[];
    /**
     * Prisma environment class used for the managed environment variable keys.
     */
    environmentClass?: "production" | "preview";
    /**
     * Branch ID used for managed preview branch environment overrides, or null
     * for project-level environment templates.
     */
    environmentBranchId?: string | null;
    /**
     * Fingerprint of the uploaded artifact/reused artifact inputs and the
     * branch attachment that Prisma resolves environment variables from.
     */
    artifactHash: string | undefined;
    /**
     * Whether the app output represents a local dev process.
     */
    local: boolean;
  },
  {
    env?: Record<string, string | Redacted.Redacted<string> | null | undefined>;
  },
  Providers
> {}

export type ComputeServices = Server.ProcessServices;

export type ComputeShape = Main<ComputeServices>;

export interface ComputeRuntimeContext extends Server.ProcessContext {
  readonly Type: ComputeTypeId;
}

export const isCompute = (value: unknown): value is Compute =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === ComputeTypeId;

const hasEffectNativeComputeInput = (props: ComputeProps) =>
  props.isExternal !== true &&
  (props.main !== undefined || props.exports !== undefined);

const isEffectNativeCompute = (props: ComputeProps) =>
  hasEffectNativeComputeInput(props);

/**
 * A Prisma Compute deployment resource.
 *
 * @section Deploying an App
 * @example Deploy a directory with an entrypoint
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   serviceName: "api",
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   port: 3000,
 * });
 * ```
 *
 * @example Deploy an Effect-native HTTP app
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   {
 *     project,
 *     serviceName: "api",
 *     main: import.meta.filename,
 *     port: 8080,
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: HttpServerResponse.text("ok"),
 *     };
 *   }),
 * );
 * ```
 *
 * @section Runtime Bindings
 * @example Bind a Prisma Connection
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   {
 *     project,
 *     serviceName: "api",
 *     main: import.meta.filename,
 *   },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.ConnectionBinding(connection);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* db.databaseUrl;
 *         return HttpServerResponse.text(databaseUrl ?? "");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
 * );
 * ```
 *
 * @example Build before upload and replace old versions
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   serviceName: "api",
 *   path: "./apps/api",
 *   build: {
 *     command: "bun build src/server.ts --target bun --outdir dist",
 *     outdir: "dist",
 *     entrypoint: "server.js",
 *   },
 *   port: 8080,
 *   env: {
 *     DATABASE_URL: database.directConnectionString,
 *   },
 *   destroyOldVersion: true,
 * });
 * ```
 *
 * @example Auto-build a framework app
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   serviceName: "api",
 *   path: "./apps/web",
 *   build: "auto",
 *   destroyOldVersion: true,
 * });
 * ```
 *
 * @example Deploy a prebuilt tar.gz artifact
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   serviceName: "api",
 *   artifactPath: "./dist/app.tar.gz",
 *   port: 8080,
 * });
 * ```
 *
 * @section Local Development
 * @example Run locally during alchemy dev
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   serviceName: "api",
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   dev: {
 *     command: "bun run dev",
 *     port: 3000,
 *   },
 * });
 * ```
 */
export const Compute: Platform<
  Compute,
  ComputeServices,
  ComputeShape,
  ComputeRuntimeContext
> & {
  <PropsReq = never>(
    id: string,
    props:
      | InputProps<ComputeProps>
      | Effect.Effect<InputProps<ComputeProps>, never, PropsReq>,
  ): Effect.Effect<Compute, never, Providers | PropsReq>;
} = Platform(ComputeTypeId, {
  createRuntimeContext: (id): ComputeRuntimeContext => {
    const runners: Effect.Effect<void, never, unknown>[] = [];
    const env: Record<string, unknown> = {};
    let runtimeContext: ComputeRuntimeContext;
    const run: Server.ProcessContext["run"] = (effect) =>
      Effect.sync(() => {
        runners.push(effect);
      });

    const serve = <Req = never>(handler: HttpEffect<Req>) =>
      Effect.sync(() => {
        runners.push(
          Effect.gen(function* () {
            const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
              Effect.map(Option.getOrUndefined),
            );
            if (httpServer) {
              yield* httpServer.serve(
                handler.pipe(
                  Effect.provideService(RuntimeContext, runtimeContext),
                ),
              );
              yield* Effect.never;
            }
          }).pipe(Effect.catch((error: unknown) => Effect.die(error))),
        );
      });

    runtimeContext = {
      Type: ComputeTypeId,
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          env[key] = output.pipe(
            Output.map((value) =>
              Redacted.isRedacted(value)
                ? Redacted.make(
                    JSON.stringify({
                      _tag: "Redacted",
                      value: Redacted.value(value),
                    }),
                  )
                : JSON.stringify(value),
            ),
          );
          return key;
        }),
      get: <T>(key: string) =>
        // Runtime ConfigProvider lookups call back into RuntimeContext.get.
        // Read the process env directly here to avoid re-entering that path.
        Effect.sync(() => {
          const value = process.env[key];
          if (value === undefined) {
            return undefined;
          }
          try {
            const parsed = JSON.parse(value);
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              (parsed as { _tag?: unknown })._tag === "Redacted" &&
              "value" in (parsed as object)
            ) {
              return Redacted.make((parsed as { value: string }).value) as T;
            }
            return parsed as T;
          } catch {
            return value as T;
          }
        }),
      run,
      serve,
      exports: Effect.sync(() => ({
        default: Effect.all(
          runners.map((effect) =>
            Effect.forever(
              effect.pipe(
                Effect.tapError((error) => Effect.logError(error)),
                Effect.ignore,
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      })),
    };
    return runtimeContext;
  },
});

const devProcesses = new Map<string, ChildProcessHandle>();

const projectConsistencySchedule = Schedule.exponential(
  Duration.millis(500),
).pipe(Schedule.both(Schedule.recurs(8)));

const isProjectScopedNotFound = (error: unknown): boolean =>
  error instanceof PrismaApiError &&
  error.status === 404 &&
  error.path.startsWith("/v1/projects/");

const isComputeServiceRouteNotFound = (error: unknown): boolean =>
  error instanceof PrismaApiError &&
  error.status === 404 &&
  error.path === "/v1/compute-services";

const computeApiUnavailable = () =>
  new Error(
    [
      "Prisma Compute API is not available for the configured credentials/base URL.",
      "The live smoke needs /v1/compute-services access.",
      "Provide PRISMA_SERVICE_TOKEN or PRISMA_API_TOKEN with a matching PRISMA_API_URL/PRISMA_MANAGEMENT_API_URL for a Compute-enabled Prisma environment.",
    ].join(" "),
  );

const findService = (
  client: PrismaManagementClient,
  projectId: string,
  serviceName: string,
) =>
  client
    .listProjectComputeServices(projectId, { limit: 100 })
    .pipe(
      Effect.map((services: ApiComputeService[]) =>
        services.find((service) => service.name === serviceName),
      ),
    );

const createService = (
  client: PrismaManagementClient,
  projectId: string,
  props: ComputeProps,
) => {
  const attach = branchAttachment(props);
  const input = {
    displayName: props.serviceName,
    regionId: props.regionId ?? "us-east-1",
    branchId: attach.branchId,
    branchGitName: attach.branchGitName,
  };
  return client.createProjectComputeService(projectId, input);
};

const plainEnv = (
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]],
    ),
  ) as Record<string, string | null>;

const managedEnvKeys = (
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) =>
  Object.entries(plainEnv(env))
    .flatMap(([key, value]) => (value === null ? [] : [key]))
    .sort();

const envKeysRecord = (
  keys: readonly string[] | undefined,
): Record<string, string> =>
  Object.fromEntries((keys ?? []).map((key) => [key, ""]));

const previousManagedEnv = (
  keys: readonly string[] | undefined,
  env:
    | Record<string, string | Redacted.Redacted<string> | null | undefined>
    | undefined,
): Record<string, string | Redacted.Redacted<string> | null | undefined> => ({
  ...env,
  ...envKeysRecord(keys),
});

const branchAttachment = (props: ComputeProps) =>
  props.branchId !== undefined && !isPrismaDevId(props.branchId)
    ? {
        branchId: props.branchId,
        branchGitName: undefined,
      }
    : props.branchGitName !== undefined
      ? {
          branchId: undefined,
          branchGitName: props.branchGitName,
        }
      : {
          branchGitName: "main",
        };

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_VALUE_MAX_BYTES = 8 * 1024;
const EXPORT_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const computeEnvValue = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const validateComputeEnvironmentKey = (key: string) =>
  Effect.gen(function* () {
    if (key.length < 1 || key.length > 256 || !ENV_KEY_PATTERN.test(key)) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable key '${key}' must match POSIX env-var key shape: [A-Z_][A-Z0-9_]* and be at most 256 characters.`,
        ),
      );
    }
  });

const validateComputeEnvironmentWrite = (
  key: string,
  value: string | Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    yield* validateComputeEnvironmentKey(key);
    const raw = computeEnvValue(value);
    if (raw.length === 0) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value must be non-empty.`,
        ),
      );
    }
    const byteLength = yield* Effect.sync(
      () => new TextEncoder().encode(raw).byteLength,
    );
    if (byteLength > ENV_VALUE_MAX_BYTES) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value exceeds ${ENV_VALUE_MAX_BYTES} bytes.`,
        ),
      );
    }
  });

const validateComputeProps = (props: ComputeProps) =>
  Effect.gen(function* () {
    for (const [key, value] of Object.entries(props.env ?? {})) {
      if (value === undefined) continue;
      if (value === null) {
        yield* validateComputeEnvironmentKey(key);
      } else {
        yield* validateComputeEnvironmentWrite(key, value);
      }
    }
    if ((props.skipPromote ?? false) && (props.destroyOldVersion ?? false)) {
      return yield* Effect.fail(
        new Error(
          "destroyOldVersion cannot be combined with skipPromote because the previous version stays active when promotion is skipped.",
        ),
      );
    }
    if (props.start === false && !(props.skipPromote ?? false)) {
      return yield* Effect.fail(
        new Error(
          "start: false requires skipPromote: true because Prisma Compute promotion requires a running version.",
        ),
      );
    }
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* Effect.fail(
        new Error("branchId and branchGitName are mutually exclusive."),
      );
    }
    if (props.branchId === null || props.branchGitName === null) {
      return yield* Effect.fail(
        new Error(
          "Prisma.Compute requires an attached branch because Compute version creation resolves environment variables from the service branch. Omit branchGitName to use main, or set branchId/branchGitName.",
        ),
      );
    }
    if (props.artifact !== undefined && props.artifactPath !== undefined) {
      return yield* Effect.fail(
        new Error("artifact and artifactPath are mutually exclusive."),
      );
    }
    if ((props.skipCodeUpload ?? false) && props.artifact !== undefined) {
      return yield* Effect.fail(
        new Error("skipCodeUpload cannot be combined with artifact."),
      );
    }
    if ((props.skipCodeUpload ?? false) && props.artifactPath !== undefined) {
      return yield* Effect.fail(
        new Error("skipCodeUpload cannot be combined with artifactPath."),
      );
    }
    if ((props.skipCodeUpload ?? false) && props.build !== undefined) {
      return yield* Effect.fail(
        new Error("skipCodeUpload cannot be combined with build."),
      );
    }
    if (hasEffectNativeComputeInput(props)) {
      const handler = props.handler ?? "default";
      if (handler !== "default" && !EXPORT_IDENTIFIER_PATTERN.test(handler)) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute handler must be `default` or a valid JavaScript export identifier.",
          ),
        );
      }
      if (props.main === undefined) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute apps require `main`. Set `main: import.meta.filename`.",
          ),
        );
      }
      if (props.artifact !== undefined || props.artifactPath !== undefined) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute apps cannot use artifact or artifactPath.",
          ),
        );
      }
      if (props.build !== undefined) {
        return yield* Effect.fail(
          new Error("Effect-native Prisma Compute apps cannot use build."),
        );
      }
      if (props.skipCodeUpload) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute apps cannot skip code upload.",
          ),
        );
      }
    }
  });

const branchNeedsSync = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  service: ApiComputeService,
  props: ComputeProps,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return service.branchId !== props.branchId;
  }
  const gitName =
    props.branchGitName === null ? null : (props.branchGitName ?? "main");
  if (gitName === null) {
    return service.branchId !== null;
  }
  const branch = yield* client
    .listBranches(projectId, { gitName, limit: 1 })
    .pipe(Effect.map((branches) => branches[0]));
  return branch === undefined || branch.id !== service.branchId;
});

const newlyCreatedServiceNeedsBranchSync = (
  service: ApiComputeService,
  props: ComputeProps,
) => {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return service.branchId !== props.branchId;
  }
  if (props.branchGitName === null) {
    return service.branchId !== null;
  }
  return service.branchId === null;
};

const processEnv = (
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      value === undefined || value === null
        ? []
        : [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]],
    ),
  ) as Record<string, string>;

const isPrismaEdgeServiceNotFound = (status: number, body: string) =>
  status === 404 &&
  (body.includes("There is no service on this URL") ||
    body.includes("<title>Service not found</title>"));

const waitForDeploymentUrl = Effect.fn(function* (
  url: string | undefined,
  props: ComputeProps,
) {
  if (!url || props.verifyUrl === false) return;
  const httpOption = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(httpOption)) return;

  const http = httpOption.value;
  const timeoutMs = (props.urlReadinessTimeoutSeconds ?? 60) * 1_000;
  const intervalMs = props.pollIntervalMs ?? 1_000;
  const startedAt = yield* Effect.sync(() => Date.now());
  let lastStatus: number | undefined;
  let lastBody = "";

  while (true) {
    const response = yield* http
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (response) {
      lastStatus = response.status;
      lastBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      if (!isPrismaEdgeServiceNotFound(response.status, lastBody)) {
        return;
      }
    }

    const elapsed = yield* Effect.sync(() => Date.now() - startedAt);
    if (elapsed >= timeoutMs) {
      return yield* Effect.fail(
        new Error(
          [
            `Timed out waiting for Prisma Compute URL '${url}' to become reachable.`,
            lastStatus
              ? `Last response: HTTP ${lastStatus}.`
              : "No HTTP response was received.",
            lastBody.includes("There is no service on this URL")
              ? "The Prisma edge returned: There is no service on this URL."
              : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join(" "),
        ),
      );
    }

    yield* Effect.sleep(Duration.millis(intervalMs));
  }
});

const isAutoBuild = (
  build: ComputeProps["build"],
): build is "auto" | ComputeAutoBuild =>
  build === "auto" ||
  (typeof build === "object" &&
    build !== null &&
    "type" in build &&
    build.type === "auto");

const readPackageMain = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(directory, "package.json"))
    .pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    );
  if (!text) return undefined;
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as { main?: unknown };
      return typeof parsed.main === "string" ? parsed.main : undefined;
    },
    catch: (cause) =>
      new Error(`Failed to parse package.json in ${directory}: ${cause}`),
  });
});

const writeBundleDirectory = Effect.fn(function* (bundle: Bundle.BundleOutput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectory({
    prefix: "alchemy-prisma-compute-",
  });

  for (const file of bundle.files) {
    const target = path.join(directory, file.path);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    if (typeof file.content === "string") {
      yield* fs.writeFileString(target, file.content);
    } else {
      yield* fs.writeFile(target, file.content);
    }
  }

  return {
    directory,
    entrypoint: bundle.files[0].path,
    cleanup: fs
      .remove(directory, { recursive: true })
      .pipe(Effect.catch(() => Effect.void)),
  };
});

const bundleEffectCompute = Effect.fn(function* (props: ComputeProps) {
  if (!props.main) {
    return yield* Effect.fail(
      new Error(
        "Effect-native Prisma Compute apps require `main`. Set `main: import.meta.filename`.",
      ),
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const stack = yield* Effect.serviceOption(Stack).pipe(
    Effect.map(
      Option.getOrElse(() => ({
        name: "alchemy",
        stage: "dev",
        bindings: {},
        resources: {},
      })),
    ),
  );
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* fs.realPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const handler = props.handler ?? "default";
  const defaultPort = props.port ?? 8080;

  const importEntrypoint =
    handler === "default"
      ? "import entrypoint"
      : `import { ${handler} as entrypoint }`;

  const bundle = yield* Bundle.build(
    {
      ...props.bundle?.input,
      input: realMain,
      cwd,
      platform: "node",
      plugins: [
        props.bundle?.input?.plugins,
        virtualEntryPlugin(
          (importPath) => `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer } from "alchemy/Runtime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";

${importEntrypoint} from ${JSON.stringify(importPath)};

process.env.PORT ??= ${JSON.stringify(String(defaultPort))};

const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.succeed(Stack, {
  name: ${JSON.stringify(stack.name)},
  stage: ${JSON.stringify(stack.stage)},
  bindings: {},
  resources: {},
});

const program = tag.pipe(
  Effect.flatMap((app) => app.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.default),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
            ConfigProvider.fromEnv(),
          ),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          process.env.DEBUG ? "Debug" : "Info",
        ),
      ),
    ),
  ),
  Effect.scoped,
);

console.log("Prisma Compute bootstrap starting...");
await Effect.runPromise(program).catch((error) => {
  console.error("Prisma Compute bootstrap failed:", error);
  process.exit(1);
});
`,
        ),
      ],
      checks: {
        unresolvedImport: false,
        ineffectiveDynamicImport: false,
      },
    },
    {
      ...props.bundle?.output,
      format: "esm",
      sourcemap: props.bundle?.output?.sourcemap ?? "hidden",
      minify: props.bundle?.output?.minify ?? true,
      entryFileNames: "index.js",
    },
    props.bundle?.extra,
  );

  const artifact = yield* writeBundleDirectory(bundle);
  const bytes = yield* createComputeArchive({
    directory: artifact.directory,
    entrypoint: artifact.entrypoint,
  }).pipe(Effect.ensuring(artifact.cleanup));

  return {
    bytes,
    bundleHash: bundle.hash,
  };
});

const resolveArtifact = Effect.fn(function* (props: ComputeProps) {
  const env = plainEnv(props.env);
  const envClass = props.envClass ?? "production";
  const defaultPort = props.port ?? 8080;
  if (isEffectNativeCompute(props)) {
    if (props.artifact !== undefined || props.artifactPath !== undefined) {
      return yield* Effect.fail(
        new Error(
          "Effect-native Prisma Compute apps cannot use artifact or artifactPath.",
        ),
      );
    }
    if (props.skipCodeUpload) {
      return yield* Effect.fail(
        new Error("Effect-native Prisma Compute apps cannot skip code upload."),
      );
    }
    if (props.build !== undefined) {
      return yield* Effect.fail(
        new Error("Effect-native Prisma Compute apps cannot use build."),
      );
    }
    const artifact = yield* bundleEffectCompute(props);
    return {
      bytes: artifact.bytes,
      hash: yield* sha256Object({
        bundle: artifact.bundleHash,
        env,
        envClass,
        port: defaultPort,
      }),
      port: defaultPort,
    };
  }

  if (props.skipCodeUpload) {
    return {
      bytes: undefined,
      hash: yield* sha256Object({
        skipCodeUpload: true,
        env,
        envClass,
        port: defaultPort,
      }),
      port: defaultPort,
    };
  }

  if (props.artifact !== undefined || props.artifactPath !== undefined) {
    const bytes = yield* readUploadArtifact(props);
    return {
      bytes: bytes!,
      hash: yield* sha256Object({
        artifact: yield* sha256(bytes!),
        env,
        envClass,
        port: defaultPort,
      }),
      port: defaultPort,
    };
  }

  const path = yield* Path.Path;
  const appPath = path.resolve(props.path ?? ".");
  let directory = appPath;
  let entrypoint = props.entrypoint;
  let port = defaultPort;

  if (isAutoBuild(props.build)) {
    const auto = props.build === "auto" ? undefined : props.build;
    const artifact = yield* runComputeAutoBuild({
      appPath,
      entrypoint,
      framework: auto?.framework,
      env: auto?.env,
    });
    const bytes = yield* createComputeArchive({
      directory: artifact.directory,
      entrypoint: artifact.entrypoint,
    }).pipe(Effect.ensuring(artifact.cleanup));
    port = props.port ?? artifact.defaultPort ?? 8080;
    return {
      bytes,
      hash: yield* sha256Object({
        artifact: yield* sha256(bytes),
        env,
        envClass,
        port,
      }),
      port,
    };
  }

  if (props.build) {
    const cwd = props.build.cwd ? path.resolve(props.build.cwd) : appPath;
    yield* runBuildCommand({
      command: props.build.command,
      cwd,
      env: processEnv(props.build.env),
    });
    directory = path.resolve(cwd, props.build.outdir);
    entrypoint = props.build.entrypoint ?? entrypoint;
  }

  entrypoint ??= yield* readPackageMain(directory);
  if (!entrypoint) {
    return yield* Effect.fail(
      new Error(
        "Prisma Compute app entrypoint is required. Set `entrypoint` or package.json `main`.",
      ),
    );
  }

  const normalizedEntrypoint = yield* normalizeEntrypoint(entrypoint);
  const bytes = yield* createComputeArchive({
    directory,
    entrypoint: normalizedEntrypoint,
  });
  return {
    bytes,
    hash: yield* sha256Object({
      artifact: yield* sha256(bytes),
      env,
      envClass,
      port,
    }),
    port,
  };
});

const findExistingService = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  props: ComputeProps,
  output: Compute["Attributes"] | undefined,
) {
  const computeServiceId =
    output?.computeServiceId && !isPrismaDevId(output.computeServiceId)
      ? output.computeServiceId
      : undefined;
  return computeServiceId
    ? yield* client
        .getComputeService(computeServiceId)
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)))
    : yield* findService(client, projectId, props.serviceName);
});

const ensureService = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  props: ComputeProps,
  output: Compute["Attributes"] | undefined,
  observedService?: ApiComputeService,
) {
  let service =
    observedService ??
    (yield* findExistingService(client, projectId, props, output));

  let createdService = false;
  if (!service) {
    const result = yield* createService(client, projectId, props).pipe(
      Effect.map((service) => ({ service, created: true })),
      Effect.catchIf(isConflict, () =>
        findService(client, projectId, props.serviceName).pipe(
          Effect.flatMap((service) =>
            service
              ? Effect.succeed({ service, created: false })
              : Effect.fail(
                  new Error(
                    `Prisma compute service '${props.serviceName}' already exists but could not be read`,
                  ),
                ),
          ),
        ),
      ),
    );
    service = result.service;
    createdService = result.created;
  }

  const attach = branchAttachment(props);
  const needsBranchSync = createdService
    ? newlyCreatedServiceNeedsBranchSync(service, props)
    : yield* branchNeedsSync(client, projectId, service, props);
  if (service.name !== props.serviceName || needsBranchSync) {
    service = yield* client.updateComputeService(service.id, {
      displayName: props.serviceName,
      branchId: attach.branchId,
      branchGitName: attach.branchGitName,
    });
  }

  return { service, created: createdService };
});

const ensureSkipCodeUploadCanFork = (
  props: ComputeProps,
  service: ApiComputeService | undefined,
) =>
  Effect.gen(function* () {
    if (!(props.skipCodeUpload ?? false)) return;
    if (service?.latestVersionId) return;
    return yield* Effect.fail(
      new Error(
        "skipCodeUpload requires an existing Prisma Compute version to fork from. Upload and start a version first, or remove skipCodeUpload.",
      ),
    );
  });

const findEnvironmentVariable = (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  key: string,
  branchId?: string | null,
) =>
  client
    .listEnvironmentVariables({
      projectId,
      class: cls,
      key,
      ...(branchId ? { branchId } : {}),
      limit: 100,
    })
    .pipe(
      Effect.map((variables: ApiEnvironmentVariable[]) =>
        variables.find((variable) => variable.branchId === (branchId ?? null)),
      ),
    );

const systemManagedEnvironmentVariableError = (key: string) =>
  new Error(
    `Prisma environment variable '${key}' is managed by Prisma and cannot be managed by Alchemy.`,
  );

const ensureUserManagedEnvironmentVariable = (
  variable: ApiEnvironmentVariable,
) =>
  Effect.gen(function* () {
    if (variable.isManagedBySystem) {
      return yield* Effect.fail(
        systemManagedEnvironmentVariableError(variable.key),
      );
    }
  });

interface ComputeEnvironmentScope {
  class: "production" | "preview";
  branchId: string | null;
}

const environmentScope = (
  cls: "production" | "preview",
  branchId?: string | null,
): ComputeEnvironmentScope => ({
  class: cls,
  branchId: branchId ?? null,
});

const sameEnvironmentScope = (
  left: ComputeEnvironmentScope,
  right: ComputeEnvironmentScope,
) => left.class === right.class && left.branchId === right.branchId;

const resolveComputeEnvironmentScope = Effect.fn(function* (
  client: PrismaManagementClient,
  service: ApiComputeService,
  props: ComputeProps,
) {
  if (!service.branchId) {
    return yield* Effect.fail(
      new Error(
        "Prisma.Compute requires an attached branch because Compute version creation resolves environment variables from the service branch.",
      ),
    );
  }

  const branch = yield* client.getBranch(service.branchId);
  const inferredClass = branch.role;
  if (props.envClass !== undefined && props.envClass !== inferredClass) {
    return yield* Effect.fail(
      new Error(
        `Prisma.Compute envClass '${props.envClass}' does not match attached branch role '${inferredClass}'. Omit envClass to let Alchemy infer the correct environment variable scope.`,
      ),
    );
  }

  return environmentScope(
    inferredClass,
    inferredClass === "preview" ? service.branchId : null,
  );
});

export const syncComputeEnvironment = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
  branchId?: string | null,
) {
  const synced: string[] = [];
  const deleted: string[] = [];
  for (const [key, value] of Object.entries(plainEnv(env))) {
    if (value === null) {
      yield* validateComputeEnvironmentKey(key);
    } else {
      yield* validateComputeEnvironmentWrite(key, value);
    }
    const variable = yield* findEnvironmentVariable(
      client,
      projectId,
      cls,
      key,
      branchId,
    );
    if (variable) {
      yield* ensureUserManagedEnvironmentVariable(variable);
    }
    if (value === null) {
      if (variable) {
        yield* client
          .deleteEnvironmentVariable(variable.id)
          .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        deleted.push(key);
      }
      continue;
    }

    if (variable) {
      yield* client.updateEnvironmentVariable(variable.id, { value });
    } else {
      yield* client.createEnvironmentVariable({
        projectId,
        ...(branchId ? { branchId } : {}),
        class: cls,
        key,
        value,
      });
    }
    synced.push(key);
  }
  return { synced, deleted };
});

const destroyComputeEnvironment = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  scope: ComputeEnvironmentScope,
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) {
  const deleted: string[] = [];
  for (const [key, value] of Object.entries(plainEnv(env))) {
    if (value === null) continue;
    const variable = yield* findEnvironmentVariable(
      client,
      projectId,
      scope.class,
      key,
      scope.branchId,
    ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
    if (!variable) continue;
    if (variable.isManagedBySystem) continue;
    yield* client
      .deleteEnvironmentVariable(variable.id)
      .pipe(Effect.catchIf(isNotFound, () => Effect.void));
    deleted.push(key);
  }
  return { deleted };
});

const cleanupRemovedComputeEnvironment = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  oldScope: ComputeEnvironmentScope,
  oldEnv:
    | Record<string, string | Redacted.Redacted<string> | null | undefined>
    | undefined,
  newScope: ComputeEnvironmentScope,
  newEnv:
    | Record<string, string | Redacted.Redacted<string> | null | undefined>
    | undefined,
) {
  const oldValues = plainEnv(oldEnv);
  const newValues = plainEnv(newEnv);
  const deleted: string[] = [];
  for (const [key, oldValue] of Object.entries(oldValues)) {
    if (oldValue === null) continue;
    if (sameEnvironmentScope(oldScope, newScope) && key in newValues) continue;
    const variable = yield* findEnvironmentVariable(
      client,
      projectId,
      oldScope.class,
      key,
      oldScope.branchId,
    );
    if (!variable) continue;
    if (variable.isManagedBySystem) continue;
    yield* client
      .deleteEnvironmentVariable(variable.id)
      .pipe(Effect.catchIf(isNotFound, () => Effect.void));
    deleted.push(key);
  }
  return { deleted };
});

const startDev = Effect.fn(function* (id: string, props: ComputeProps) {
  const path = yield* Path.Path;
  const dev = props.dev;
  const processKey = `dev:${id}`;
  const localUrl =
    dev?.url ??
    ((dev?.port ?? props.port)
      ? `http://localhost:${dev?.port ?? props.port}`
      : undefined);
  if (!dev?.command) {
    return localUrl;
  }

  const existing = devProcesses.get(processKey);
  if (
    existing &&
    (yield* existing.isRunning.pipe(Effect.orElseSucceed(() => false)))
  ) {
    yield* existing.kill().pipe(Effect.catch(() => Effect.void));
  }

  const cwd = dev.cwd ? path.resolve(dev.cwd) : path.resolve(props.path ?? ".");
  const env = {
    ...processEnv(props.env),
    ...processEnv(dev.env),
    ...((dev.port ?? props.port)
      ? { PORT: String(dev.port ?? props.port) }
      : {}),
  };
  const handle = yield* ChildProcess.make(dev.command, [], {
    shell: true,
    cwd,
    env,
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: false,
  });
  devProcesses.set(processKey, handle);
  return localUrl;
});

const activeBindingEnv = (
  bindings: ResourceBinding<Compute["Binding"]>[],
): Record<string, string | Redacted.Redacted<string> | null | undefined> =>
  bindings
    .filter(
      (binding: ResourceBinding<Compute["Binding"]> & { action?: string }) =>
        binding.action !== "delete",
    )
    .map((binding) => binding.data?.env)
    .reduce<
      Record<string, string | Redacted.Redacted<string> | null | undefined>
    >(
      (acc, env) => (env ? { ...acc, ...env } : acc),
      {} as Record<
        string,
        string | Redacted.Redacted<string> | null | undefined
      >,
    );

export const ComputeProvider = () =>
  Provider.effect(
    Compute,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["computeServiceId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (output?.local || isPrismaDevId(output?.computeServiceId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (isResolved(news.regionId) &&
              (news.regionId ?? "us-east-1") !== (olds.regionId ?? "us-east-1"))
          ) {
            return { action: "replace" } as const;
          }
          // Source files/build output can change with no prop change, so
          // reconcile must rerun and decide from the computed artifact hash.
          return { action: "update" } as const;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          if (output?.local) return output;
          const computeServiceId =
            output?.computeServiceId && !isPrismaDevId(output.computeServiceId)
              ? output.computeServiceId
              : undefined;
          const service = computeServiceId
            ? yield* client
                .getComputeService(computeServiceId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findService(client, projectId, olds.serviceName)
                  : undefined;
              });
          if (!service) return undefined;
          const readVersion = (id: string) =>
            observeComputeVersion(client, id).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
          const outputVersion = output?.computeVersionId
            ? yield* readVersion(output.computeVersionId)
            : undefined;
          const latestVersion =
            !outputVersion && service.latestVersionId
              ? yield* readVersion(service.latestVersionId)
              : undefined;
          const version = outputVersion ?? latestVersion;
          const versionUrl = toDeploymentUrl(
            version?.previewDomain ?? undefined,
          );
          const serviceUrl = toDeploymentUrl(service.serviceEndpointDomain);
          const promoted =
            service.latestVersionId !== null &&
            version?.id === service.latestVersionId;
          return {
            computeServiceId: service.id,
            computeVersionId: version?.id,
            projectId: service.projectId ?? output?.projectId,
            serviceName: service.name,
            regionId: service.region.id,
            versionEndpointDomain: version?.previewDomain ?? undefined,
            versionUrl,
            serviceEndpointDomain:
              service.serviceEndpointDomain ?? output?.serviceEndpointDomain,
            url: promoted ? (serviceUrl ?? versionUrl) : versionUrl,
            promoted,
            previousVersionId: output?.previousVersionId,
            previousVersionAction: output?.previousVersionAction,
            environmentKeys: output?.environmentKeys,
            environmentClass: output?.environmentClass ?? olds.envClass,
            environmentBranchId: output?.environmentBranchId,
            artifactHash: output?.artifactHash,
            local: false,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
          const bindingEnv = activeBindingEnv(bindings);
          const effectiveNews = {
            ...news,
            env: {
              ...bindingEnv,
              ...news.env,
            },
          };
          yield* validateComputeProps(effectiveNews);
          const projectId = yield* resolveProjectId(effectiveNews.project);
          const artifact = yield* resolveArtifact(effectiveNews);
          const observedService = effectiveNews.skipCodeUpload
            ? yield* findExistingService(
                client,
                projectId,
                effectiveNews,
                output,
              ).pipe(
                Effect.retry({
                  while: isProjectScopedNotFound,
                  schedule: projectConsistencySchedule,
                }),
                Effect.catchIf(isComputeServiceRouteNotFound, () =>
                  Effect.fail(computeApiUnavailable()),
                ),
              )
            : undefined;
          yield* ensureSkipCodeUploadCanFork(effectiveNews, observedService);
          const ensuredService = yield* ensureService(
            client,
            projectId,
            effectiveNews,
            output,
            observedService,
          ).pipe(
            Effect.retry({
              while: isProjectScopedNotFound,
              schedule: projectConsistencySchedule,
            }),
            Effect.catchIf(isComputeServiceRouteNotFound, () =>
              Effect.fail(computeApiUnavailable()),
            ),
          );
          const service = ensuredService.service;
          const cleanupCreatedServiceOnFailure = (error: unknown) =>
            ensuredService.created
              ? destroyComputeService(client, service.id).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(() => Effect.fail(error)),
                )
              : Effect.fail(error);

          return yield* Effect.gen(function* () {
            const currentEnvironmentScope =
              yield* resolveComputeEnvironmentScope(
                client,
                service,
                effectiveNews,
              );
            const deploymentHash = yield* sha256Object({
              artifact: artifact.hash,
              branchId: service.branchId,
              environmentClass: currentEnvironmentScope.class,
              environmentBranchId: currentEnvironmentScope.branchId,
            });
            const previousVersionId = service.latestVersionId ?? null;
            const previousEnvironmentScope = environmentScope(
              olds?.envClass ?? output?.environmentClass ?? "production",
              output?.environmentBranchId,
            );
            yield* cleanupRemovedComputeEnvironment(
              client,
              projectId,
              previousEnvironmentScope,
              previousManagedEnv(output?.environmentKeys, olds?.env),
              currentEnvironmentScope,
              effectiveNews.env,
            );
            yield* syncComputeEnvironment(
              client,
              projectId,
              currentEnvironmentScope.class,
              effectiveNews.env,
              currentEnvironmentScope.branchId,
            );

            let version: ObservedComputeVersion | undefined =
              output?.computeVersionId && output.artifactHash === deploymentHash
                ? yield* observeComputeVersion(
                    client,
                    output.computeVersionId,
                  ).pipe(
                    Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                  )
                : undefined;
            let createdVersionId: string | undefined;
            const cleanupCreatedVersionOnFailure = (
              versionId: string,
              error: unknown,
            ) =>
              createdVersionId === versionId
                ? destroyComputeVersion(client, versionId, effectiveNews).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.andThen(() => Effect.fail(error)),
                  )
                : Effect.fail(error);

            if (!version) {
              const created = yield* client.createServiceComputeVersion(
                service.id,
                {
                  portMapping: { http: artifact.port },
                  skipCodeUpload: effectiveNews.skipCodeUpload,
                },
              );
              createdVersionId = created.id;
              const cleanupCreatedVersion = destroyComputeVersion(
                client,
                created.id,
                effectiveNews,
              ).pipe(Effect.catch(() => Effect.void));
              if (artifact.bytes !== undefined && !created.uploadUrl) {
                yield* cleanupCreatedVersion;
                return yield* Effect.fail(
                  new Error(
                    "Prisma Compute version creation did not return an upload URL.",
                  ),
                );
              }
              if (created.uploadUrl && artifact.bytes !== undefined) {
                yield* uploadArtifact(
                  created.uploadUrl,
                  artifact.bytes,
                  "application/gzip",
                ).pipe(
                  Effect.catch((error) =>
                    cleanupCreatedVersion.pipe(
                      Effect.andThen(() => Effect.fail(error)),
                    ),
                  ),
                );
              }
              version = yield* observeComputeVersion(client, created.id).pipe(
                Effect.catchIf(isNotFound, () =>
                  Effect.succeed({
                    id: created.id,
                    type: "compute-version" as const,
                    url: created.url,
                    foundryVersionId: created.foundryVersionId,
                    status: "new",
                    previewDomain: null,
                    createdAt: undefined,
                  }),
                ),
                Effect.catch((error) =>
                  cleanupCreatedVersionOnFailure(created.id, error),
                ),
              );
            }
            if (!version) {
              return yield* Effect.fail(
                new Error(
                  "Prisma Compute version could not be resolved after creation.",
                ),
              );
            }

            if (effectiveNews.start ?? true) {
              const currentVersion = version;
              const versionId = currentVersion.id;
              version = yield* Effect.gen(function* () {
                if (
                  currentVersion.status !== "running" &&
                  currentVersion.status !== "provisioning"
                ) {
                  yield* startComputeServiceVersionWithFallback(
                    client,
                    currentVersion.id,
                  );
                }
                const running = yield* waitForComputeVersionStatus(
                  client,
                  currentVersion.id,
                  "running",
                  effectiveNews,
                );
                yield* waitForDeploymentUrl(
                  toDeploymentUrl(running.previewDomain),
                  effectiveNews,
                );
                return running;
              }).pipe(
                Effect.catch((error) =>
                  cleanupCreatedVersionOnFailure(versionId, error),
                ),
              );
            }

            let serviceEndpointDomain = service.serviceEndpointDomain;
            let previousVersionAction:
              | "stopped"
              | "destroyed"
              | "still-active"
              | null = previousVersionId ? "still-active" : null;
            if (!(effectiveNews.skipPromote ?? false)) {
              if (previousVersionId !== version.id) {
                const promoted = yield* client
                  .promoteComputeService(service.id, version.id)
                  .pipe(
                    Effect.catch((error) =>
                      cleanupCreatedVersionOnFailure(version.id, error),
                    ),
                  );
                serviceEndpointDomain = promoted.serviceEndpointDomain;
              }
              if (previousVersionId && previousVersionId !== version.id) {
                yield* stopComputeServiceVersionWithFallback(
                  client,
                  previousVersionId,
                );
                yield* waitForComputeVersionStatus(
                  client,
                  previousVersionId,
                  "stopped",
                  effectiveNews,
                ).pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                );
                previousVersionAction = "stopped";
                if (effectiveNews.destroyOldVersion ?? false) {
                  yield* destroyComputeVersion(
                    client,
                    previousVersionId,
                    effectiveNews,
                  );
                  previousVersionAction = "destroyed";
                }
              }
            }

            const versionUrl = toDeploymentUrl(version.previewDomain);
            const serviceUrl =
              toDeploymentUrl(serviceEndpointDomain) ??
              toDeploymentUrl(version.previewDomain);
            const promoted = !(effectiveNews.skipPromote ?? false);
            if (promoted) {
              yield* waitForDeploymentUrl(serviceUrl, effectiveNews);
            }

            return {
              computeServiceId: service.id,
              computeVersionId: version.id,
              projectId,
              serviceName: service.name,
              regionId: service.region.id,
              versionEndpointDomain: version.previewDomain ?? undefined,
              versionUrl,
              serviceEndpointDomain,
              url: promoted ? serviceUrl : versionUrl,
              promoted,
              previousVersionId,
              previousVersionAction,
              environmentKeys: managedEnvKeys(effectiveNews.env),
              environmentClass: currentEnvironmentScope.class,
              environmentBranchId: currentEnvironmentScope.branchId,
              artifactHash: deploymentHash,
              local: false,
            };
          }).pipe(Effect.catch(cleanupCreatedServiceOnFailure));
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (output.local || isPrismaDevId(output.computeServiceId)) {
            const existing = devProcesses.get(output.computeServiceId);
            if (existing) {
              yield* existing.kill().pipe(Effect.catch(() => Effect.void));
              devProcesses.delete(output.computeServiceId);
            }
            return;
          }
          yield* destroyComputeEnvironment(
            client,
            output.projectId,
            environmentScope(
              olds?.envClass ?? output.environmentClass ?? "production",
              output.environmentBranchId,
            ),
            previousManagedEnv(output.environmentKeys, olds?.env),
          );
          yield* destroyComputeService(client, output.computeServiceId);
        }),
        tail: ({ output }) =>
          output.computeVersionId
            ? tailComputeVersionLogs(client, output.computeVersionId)
            : Stream.empty,
      };
    }),
  );

export const ComputeDevProvider = () =>
  Provider.effect(
    Compute,
    Effect.gen(function* () {
      const ctx = yield* AlchemyContext;
      return {
        stables: ["computeServiceId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* () {
          return { action: "update" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          return output?.local ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const bindingEnv = activeBindingEnv(bindings);
          const effectiveNews = {
            ...news,
            env: {
              ...bindingEnv,
              ...news.env,
            },
          };
          yield* validateComputeProps(effectiveNews);
          const projectId = yield* resolveProjectId(effectiveNews.project);
          if (!ctx.dev) {
            return yield* Effect.fail(
              new Error("ComputeDevProvider requires Alchemy dev mode."),
            );
          }
          const localUrl = yield* startDev(id, effectiveNews);
          return {
            computeServiceId: output?.computeServiceId ?? `dev:${id}`,
            computeVersionId: undefined,
            projectId,
            serviceName: effectiveNews.serviceName,
            regionId: effectiveNews.regionId ?? "us-east-1",
            versionEndpointDomain: localUrl,
            versionUrl: localUrl,
            serviceEndpointDomain: localUrl,
            url: localUrl,
            promoted: false,
            previousVersionId: undefined,
            previousVersionAction: undefined,
            environmentKeys: managedEnvKeys(effectiveNews.env),
            environmentClass: effectiveNews.envClass ?? "production",
            environmentBranchId: null,
            artifactHash: undefined,
            local: true,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const existing = devProcesses.get(output.computeServiceId);
          if (existing) {
            yield* existing.kill().pipe(Effect.catch(() => Effect.void));
            devProcesses.delete(output.computeServiceId);
          }
        }),
      };
    }),
  );
