import { AlchemyContext } from "alchemy/AlchemyContext";
import type * as Bundle from "alchemy/Bundle/Bundle";
import * as Command from "alchemy/Command";
import { deepEqual, isResolved } from "alchemy/Diff";
import { toFqn } from "alchemy/FQN";
import { HttpServer, type HttpEffect } from "alchemy/Http";
import type { InputProps } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Namespace from "alchemy/Namespace";
import { CurrentNamespace } from "alchemy/Namespace";
import * as Output from "alchemy/Output";
// Declares `globalThis.__ALCHEMY_RUNTIME__`.
import type {} from "alchemy/Phase";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { RemovalPolicy } from "alchemy/RemovalPolicy";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import type { ProcessContext, ProcessServices } from "alchemy/Runtime/Process";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import { sha256 } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import { ComputeArtifact } from "./ComputeArtifact.ts";
import { type ComputeAutoBuildFramework } from "./ComputeBuild.ts";
import { activateVersion, ComputeService } from "./ComputeService.ts";
import { ComputeVersion } from "./ComputeVersion.ts";
import { EnvironmentVariable, type EnvironmentVariableProps } from "./EnvironmentVariable.ts";
import {
  type ComputeArtifactMemo,
  ComputePackageJsonError,
} from "./internal/ComputeArtifactBuild.ts";
import { resolveProjectId } from "./internal/Refs.ts";
import { defaultServiceLogicalId } from "./internal/ServiceIdentity.ts";
import {
  ComputeInvalidProps,
  ComputeOperationFailed,
  validateComputeHealthCheck,
  type ComputeHealthCheck,
} from "./internal/UrlCheck.ts";
import { tailDeploymentLogs } from "./PrismaLogs.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import type { PrismaRegionId } from "./Types.ts";

/**
 * The stack's state for this `Prisma.Compute` was written by an earlier version
 * of this package, which managed the service, its environment variables and
 * its version inside the one resource. This version cannot take them over in
 * place, so the deploy or destroy stopped before changing anything.
 */
export class ComputeCannotUpgradeInPlace extends Data.TaggedError("ComputeCannotUpgradeInPlace")<{
  readonly message: string;
}> {}

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
   * Ambient `PRISMA_SERVICE_TOKEN` and `PRISMA_API_TOKEN` credentials are not
   * inherited; include one here explicitly only when the application build
   * genuinely needs Prisma Management API access.
   *
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`; Prisma-side encryption does not protect a value
   * already stored in Alchemy state.
   *
   * ```typescript
   * env: { NPM_TOKEN: Redacted.make(process.env.NPM_TOKEN!) }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  /**
   * Maximum bytes retained from each build output stream.
   *
   * @default 1048576 (1 MiB)
   */
  outputLimitBytes?: number;
  /**
   * Maximum wall-clock time for the build command.
   *
   * @default 900 (15 minutes)
   */
  timeoutSeconds?: number;
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
   * Ambient `PRISMA_SERVICE_TOKEN` and `PRISMA_API_TOKEN` credentials are not
   * inherited; include one here explicitly only when the application build
   * genuinely needs Prisma Management API access.
   *
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`.
   *
   * ```typescript
   * env: { NPM_TOKEN: Redacted.make(process.env.NPM_TOKEN!) }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  /**
   * Maximum bytes retained from each framework build output stream.
   *
   * @default 1048576 (1 MiB)
   */
  outputLimitBytes?: number;
  /**
   * Maximum wall-clock time for the framework build command.
   *
   * @default 900 (15 minutes)
   */
  timeoutSeconds?: number;
}

export interface ComputeStaticBuild {
  /**
   * Build a static site and package it with a production HTTP server.
   */
  type: "static";
  /**
   * Static output directory, relative to `cwd`.
   */
  outdir: string;
  /**
   * Optional shell command that creates the static output directory. Omit it
   * when `outdir` already contains the files to deploy.
   */
  command?: string;
  /**
   * Working directory for the build command and `outdir`.
   *
   * @default path
   */
  cwd?: string;
  /**
   * HTML file served at the root and for SPA fallbacks.
   *
   * @default "index.html"
   */
  indexPage?: string;
  /**
   * Serve the index page when no static file matches the request.
   *
   * @default false
   */
  spa?: boolean;
  /**
   * Environment variables supplied to the build command.
   * Ambient `PRISMA_SERVICE_TOKEN` and `PRISMA_API_TOKEN` credentials are not
   * inherited; include one here explicitly only when the application build
   * genuinely needs Prisma Management API access.
   *
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`.
   *
   * ```typescript
   * env: { NPM_TOKEN: Redacted.make(process.env.NPM_TOKEN!) }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  /**
   * Maximum bytes retained from each build output stream.
   *
   * @default 1048576 (1 MiB)
   */
  outputLimitBytes?: number;
  /**
   * Maximum wall-clock time for the build command.
   *
   * @default 900 (15 minutes)
   */
  timeoutSeconds?: number;
}

export type ComputeBuild = ComputeCommandBuild | ComputeAutoBuild | ComputeStaticBuild;

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
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface ComputeProps extends PlatformProps {
  /**
   * Project ID or `project.projectId` output that owns the service. Required
   * unless `service` is set.
   */
  project?: string | Project;
  /**
   * Serve from this Compute service instead of declaring one. Declare the
   * services first, then the Computes, to put a service's own URL, or another
   * service's, into the environment. With `service`, `project`, `serviceName`,
   * `regionId`, `branchId`, `branchGitName` and `envClass` cannot be set:
   * they belong to the service. A service given
   * by its ID requires `skipPromote: true`, because its active version can
   * only be attached to a `Prisma.ComputeService` declared in this stack.
   */
  service?: string | ComputeService;
  /**
   * Display name of the Compute service. If omitted, Alchemy generates a stable
   * physical name.
   */
  serviceName?: string;
  /**
   * Region where the service is placed.
   *
   * @default The project's default region, falling back to "us-east-1"
   */
  regionId?: PrismaRegionId;
  /**
   * Branch ID to attach the service to. Mutually exclusive with branchGitName.
   * If both branch fields are omitted, Alchemy attaches to the project's
   * current default branch.
   */
  branchId?: string;
  /**
   * Branch git name to attach the service to. Mutually exclusive with branchId.
   *
   * @default The project's current default branch
   */
  branchGitName?: string;
  /**
   * Application directory used for pre-built artifacts and build commands.
   *
   * @default "."
   */
  path?: string;
  /**
   * Additional files or directories to exclude from path deployments. Static
   * build patterns are relative to the configured output directory; other
   * patterns are artifact-relative. `*` and `**` wildcards are supported;
   * absolute paths, parent segments, and negated patterns are rejected.
   * `.env*`, `.git`, and `.alchemy` are always excluded. Static index pages
   * must remain present after exclusions.
   */
  archiveIgnore?: readonly string[];
  /**
   * Entrypoint relative to the deployed artifact directory.
   * If omitted, Alchemy reads `package.json#main`.
   */
  entrypoint?: string;
  /**
   * Entry module for an effect-native Compute app.
   *
   * This is required when you pass an inline Effect implementation to
   * `Prisma.Compute`, and ignored for external path deployments.
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
   * TanStack Start, Vite, or Bun. Set to `false` to upload `path` as a
   * pre-built artifact.
   */
  build?: ComputeBuild | false | "auto";
  /**
   * Path to a pre-created `tar.gz` artifact file. When supplied, Alchemy reads
   * and uploads it directly, and declares no `Prisma.ComputeArtifact`.
   *
   * The archive is a `tar.gz` with `compute.manifest.json` at its root,
   * `{"manifestVersion": "1", "entrypoint": "server.js"}`, beside the files it
   * names; the platform runs `entrypoint` with Bun and sets `PORT`. An archive
   * without the manifest fails before a version is created. Build one with
   * `createComputeArchive` from `@alchemy.run/prisma/ComputeArchive`, or let
   * `Prisma.ComputeArtifact` build it from a directory.
   */
  artifactPath?: string;
  /**
   * HTTP port exposed by the application.
   *
   * @default 8080
   */
  port?: number;
  /**
   * Runtime environment variables. Each key becomes a
   * `Prisma.EnvironmentVariable` at `<id>/Env/<KEY>`, written before the
   * version is created, in the class and Branch of the service's Branch. A
   * `null` value, or one that resolves to `undefined`, declares no variable,
   * so a variable declared before is deleted. A changed value creates a new
   * version. A value set by a binding overrides the same key here.
   *
   * Removing a key deletes its variable after the new version is created, so
   * that version still has it, until a later deploy creates another version.
   * To have the running app lose the key, deploy again with a changed
   * `triggers` value once the key is removed: that deploy creates a version
   * without it.
   *
   * Values are stored in Alchemy state inside a redaction marker, as plain
   * text; the version records only a salted digest of each value.
   *
   * ```typescript
   * env: {
   *   LOG_LEVEL: "info",
   *   API_TOKEN: Redacted.make(process.env.API_TOKEN!),
   * }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | null | undefined>;
  /**
   * Expected class of the environment variables. The class is the role of the
   * service's Branch; a different value here fails the deploy.
   *
   * @default the role of the service's Branch
   */
  envClass?: "production" | "preview";
  /**
   * Create the next deployment by reusing the previous code artifact.
   *
   * @default false
   */
  skipCodeUpload?: boolean;
  /**
   * Start the created/reused deployment.
   * Set `skipPromote: true` when disabling start.
   *
   * @default true
   */
  start?: boolean;
  /**
   * Do not promote the version to the service's stable endpoint.
   *
   * @default false
   */
  skipPromote?: boolean;
  /**
   * Delete the previous version when a new one replaces it. By default a
   * replaced version is kept on the platform, where it scales to zero and the
   * platform's rollback can return to it. The version the service serves is
   * never deleted on its own, also not by `alchemy destroy`: deleting the
   * service removes it, and a service kept with `RemovalPolicy.retain()` keeps
   * serving it.
   *
   * @default false
   */
  destroyOldDeployment?: boolean;
  /**
   * Extra values that create a new version when they change, for inputs the
   * application reads that Compute does not write itself. Recorded under the
   * key `triggers` of the version's `triggers`, beside the digests of the
   * environment; see `Prisma.ComputeVersion`.
   */
  triggers?: Record<string, unknown>;
  /**
   * Which files decide whether the artifact is built again; see
   * `Prisma.ComputeArtifact`'s `memo`.
   */
  memo?: ComputeArtifactMemo;
  /**
   * Maximum seconds to wait for the version to run, and for the service to
   * serve it. A new version that fails is stopped and deleted, waiting up to
   * 30 seconds, or this value when it is shorter, for it to stop.
   *
   * @default 120 for the version, 60 for the service
   */
  timeoutSeconds?: number;
  /**
   * Poll interval while waiting for start/stop.
   *
   * @default 1000
   */
  pollIntervalMs?: number;
  /**
   * Verify that Prisma's public preview URL of the version, and the stable URL of
   * the service, have reached the edge after the Management API reports the
   * version as running.
   *
   * @default true
   */
  verifyUrl?: boolean;
  /**
   * Optional application-level health check. Without this option, URL
   * verification only waits for Prisma edge routing to stop returning its
   * platform-level service-not-found response. With this option, Alchemy also
   * sends a public GET to the preview URL before promotion and to the stable
   * service URL afterward. Redirects are not followed. Each probe phase gets the
   * full `urlReadinessTimeoutSeconds` budget.
   *
   * Health checks run only during cloud deployment, not `alchemy dev`, and
   * cannot be combined with `verifyUrl: false` or `start: false`.
   */
  healthCheck?: ComputeHealthCheck;
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

/** What the `Command.Dev` a `Prisma.Compute` declares under `alchemy dev` reports to it. */
export interface ComputeDevProcess {
  /** The URL the dev process serves once it is ready. */
  devUrl: string | undefined;
}

/** What the children of a `Prisma.Compute` report to it. */
export interface ComputeComposition {
  serviceId: string;
  serviceName: string;
  serviceEndpointDomain: string;
  projectId: string;
  regionId: string;
  activeVersionId: string | null;
  serviceUrl: string;
  versionId: string;
  versionUrl: string | undefined;
  versionEndpointDomain: string | null | undefined;
  environmentKeys: string[];
  /** Whether the version is attached to the service as its active version. */
  promoted: boolean;
}

export interface Compute extends Resource<
  ComputeTypeId,
  ComputeProps,
  {
    /**
     * Prisma Compute service ID.
     */
    serviceId: string;
    /**
     * Service display name.
     */
    serviceName: string;
    /**
     * Project ID that owns the service.
     */
    projectId: string;
    /**
     * Region ID where the service is placed.
     */
    regionId: string;
    /**
     * Stable endpoint domain of the service.
     */
    serviceEndpointDomain: string | undefined;
    /**
     * ID of the version the service serves on its stable endpoint, or null
     * before any version was promoted.
     */
    activeVersionId: string | null;
    /**
     * ID of the Compute version this deploy declared. The Management API calls
     * a version a deployment.
     */
    versionId: string | undefined;
    /**
     * Preview endpoint domain of the version.
     */
    versionEndpointDomain: string | undefined;
    /**
     * HTTPS URL of the version's preview endpoint.
     */
    versionUrl: string | undefined;
    /**
     * Preferred URL: the stable URL when the version is the active version,
     * otherwise its preview URL, and the local URL in dev.
     */
    url: string | undefined;
    /**
     * Keys of the environment variables declared for the version, including
     * those set by bindings.
     */
    environmentKeys: string[];
    /**
     * Whether the output represents a local dev process.
     */
    local: boolean;
    /**
     * Set by the provider that declares the service, variables and version as
     * child resources. A row without it was written by an earlier version of
     * this package, which managed them inside this one resource.
     */
    composed: true;
  },
  ComputeComposition | ComputeDevProcess,
  Providers
> {}

export type ComputeRuntimeServices = ProcessServices;

export type ComputeShape = Main<ComputeRuntimeServices>;

export interface ComputeRuntimeContext extends ProcessContext {
  readonly Type: ComputeTypeId;
}

export { ComputePackageJsonError };

export const isCompute = (value: unknown): value is Compute =>
  typeof value === "object" && value !== null && "Type" in value && value.Type === ComputeTypeId;

/**
 * Build and deploy an application to Prisma Compute: a service with a stable
 * URL, its environment variables, and a version built from your code that the
 * service serves.
 *
 * `Prisma.Compute("api", props)` declares these child resources and reports
 * their outputs as its own attributes:
 *
 * | Resource | Logical ID | Declared |
 * | --- | --- | --- |
 * | `Prisma.ComputeService` | `api/Service` | unless `service` is set |
 * | `Prisma.EnvironmentVariable` | `api/Env/<KEY>` | one per key of `env` and of the bindings |
 * | `Prisma.ComputeArtifact` | `api/Artifact` | unless `artifactPath` or `skipCodeUpload` is set |
 * | `Prisma.ComputeVersion` | `api/Version` | always |
 *
 * The variables are written before the version is created, because Prisma
 * copies them into a version when it creates it. A changed value, artifact or
 * port creates a new version, which becomes the service's active version
 * unless `skipPromote` is set. The service's logical ID on the platform is
 * the Compute's own: `api`, or `Site.api` under the namespace `Site`.
 *
 * A replaced version is kept on the platform, where it scales to zero and the
 * platform's rollback can return to it, whatever removal policy the stack
 * uses. Set `destroyOldDeployment` to delete it instead.
 *
 * Under `alchemy dev` no cloud resource is declared: `dev.command` runs as a
 * `Command.Dev` at `api/Dev`, and `url` is the local URL. `Alchemy.remote()`
 * on the Compute deploys it to the cloud instead.
 *
 * :::caution
 * A stack deployed with an earlier release of `@alchemy.run/prisma`, which
 * kept the service inside this one resource, is refused with
 * `ComputeCannotUpgradeInPlace`: on deploy, before anything changes, and when
 * the Compute is removed or the stack destroyed, without changing or deleting
 * the old service. The error lists the options: use that earlier release, or
 * forget the old service with `alchemy state delete` and deploy a new one
 * with a new URL.
 * :::
 *
 * ### Deploying a Service
 * **Example:** Deploy a directory with an entrypoint
 * ```typescript
 * const project = yield* Prisma.Project("project", { createDatabase: false });
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   port: 3000,
 * });
 * // app.url is the service's stable URL.
 * ```
 *
 * **Example:** Deploy a prebuilt tar.gz artifact
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   artifactPath: "./dist/app.tar.gz",
 *   port: 8080,
 * });
 * ```
 *
 * ### Building the Artifact
 * The build runs again only when its inputs change; see
 * `Prisma.ComputeArtifact` for what is hashed, and `memo` to widen it.
 *
 * **Example:** Run a build command
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   build: {
 *     command: "bun build src/server.ts --target bun --outdir dist",
 *     outdir: "dist",
 *     entrypoint: "server.js",
 *   },
 * });
 * ```
 *
 * **Example:** Auto-build a framework app
 * ```typescript
 * const app = yield* Prisma.Compute("web", {
 *   project,
 *   path: "./apps/web",
 *   build: "auto",
 * });
 * ```
 *
 * **Example:** Deploy a static site
 * ```typescript
 * const web = yield* Prisma.Compute("web", {
 *   project,
 *   path: "./site",
 *   build: { type: "static", outdir: ".", spa: true },
 * });
 * ```
 *
 * **Example:** Rebuild when a sibling workspace package changes
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   build: { command: "bun run build", outdir: "dist", entrypoint: "server.js" },
 *   memo: { include: ["src/**", "package.json", "../../packages/shared/src/**"], lockfile: true },
 * });
 * ```
 *
 * ### Effect-native Apps
 * **Example:** Deploy an Effect-native HTTP app
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, main: import.meta.filename, port: 8080 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * );
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Unused code is
 * tree-shaken. `effect`, alchemy, and `@distilled.cloud` are marked
 * pure so unused parts prune more aggressively. Your app is not
 * marked pure.
 *
 * **Example:** Mark additional packages as pure
 * Only list packages with no top-level side effects.
 * ```typescript
 * {
 *   main: "./src/app.ts",
 *   bundle: {
 *     extra: { pure: { packages: ["my-lib", "@my-scope/*"] } },
 *   },
 * }
 * ```
 *
 * **Example:** Turn it off
 * ```typescript
 * {
 *   main: "./src/app.ts",
 *   bundle: { extra: { pure: false } },
 * }
 * ```
 *
 * ### Runtime Bindings
 * A binding adds environment variables, which become
 * `Prisma.EnvironmentVariable` resources like those in `env`, and override a
 * key `env` also sets.
 *
 * **Example:** Bind a Prisma Connection
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * ### Environment Variables
 * Variables belong to the project and the service's Branch, not to one
 * service: two Computes on one Branch cannot both declare a key.
 *
 * **Example:** Set variables, and drop one
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   env: {
 *     LOG_LEVEL: "info",
 *     API_TOKEN: yield* Config.redacted("API_TOKEN"),
 *     // `null` declares no variable; one declared before is deleted.
 *     LEGACY_FLAG: null,
 *   },
 * });
 * ```
 *
 * **Example:** Create a new version when another input changes
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   // The app reads flags.json at start, which Compute does not write.
 *   // Changing this value creates a new version.
 *   triggers: { flags: "2026-11-17" },
 * });
 * ```
 *
 * ### Versions and Rollback
 * **Example:** Require application readiness before promotion
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   // Checked on the version's preview URL, then on the stable URL after
 *   // promotion. When the stable check fails, the service is restored.
 *   healthCheck: { path: "/api/health", statusCodes: [200, 204] },
 * });
 * ```
 *
 * **Example:** Delete replaced versions instead of keeping them
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   destroyOldDeployment: true,
 * });
 * ```
 *
 * **Example:** Create versions without serving them
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   // app.url is the version's preview URL.
 *   skipPromote: true,
 * });
 * ```
 *
 * ### Using a Declared Service
 * Declare the services first, then the Computes, to put a service's own URL,
 * or another service's, into the environment.
 *
 * **Example:** Put a service's own URL into its environment
 * ```typescript
 * const service = yield* Prisma.ComputeService("web-service", { project });
 * const web = yield* Prisma.Compute("web", {
 *   service,
 *   path: "./apps/web",
 *   entrypoint: "server.ts",
 *   env: { PUBLIC_URL: service.url },
 * });
 * ```
 *
 * **Example:** Two services that call each other
 * ```typescript
 * const webService = yield* Prisma.ComputeService("web-service", { project });
 * const apiService = yield* Prisma.ComputeService("api-service", { project });
 * yield* Prisma.Compute("web", {
 *   service: webService,
 *   path: "./apps/web",
 *   entrypoint: "server.ts",
 *   env: { API_URL: apiService.url },
 * });
 * yield* Prisma.Compute("api", {
 *   service: apiService,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   env: { WEB_URL: webService.url },
 * });
 * ```
 *
 * ### Removal Policies and Other Decorations
 * A decoration piped onto `yield* Prisma.Compute(...)` reaches every child.
 * For a class whose Layer comes from `.make(...)`, pipe it around
 * `Effect.provide` of that Layer: piped onto `yield*` of the class alone, it
 * reaches nothing. The version keeps its own policy either way.
 *
 * **Example:** Keep everything on the platform when the stack is destroyed
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * **Example:** Decorate a class-form Compute
 * The class's module is the bundle's entry, so its Layer is the module's
 * default export.
 * ```typescript
 * // src/Api.ts
 * import * as Prisma from "@alchemy.run/prisma";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Project } from "./Project.ts";
 *
 * export class Api extends Prisma.Compute<Api>()("api") {}
 *
 * export default Api.make(
 *   Effect.gen(function* () {
 *     return { project: yield* Project, main: import.meta.filename };
 *   }),
 *   Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
 * );
 * ```
 *
 * ```typescript
 * // alchemy.run.ts
 * import ApiLive, { Api } from "./src/Api.ts";
 *
 * const api = yield* Api.pipe(Effect.provide(ApiLive), RemovalPolicy.retain());
 * ```
 *
 * ### Local Development
 * **Example:** Run locally during alchemy dev
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   // Alchemy sets PORT and waits until the port accepts a connection.
 *   dev: { command: "bun run dev", port: 3000 },
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const Compute: Platform<
  Compute,
  ComputeRuntimeServices,
  ComputeShape,
  ComputeRuntimeContext
> & {
  <PropsReq = never>(
    id: string,
    props: InputProps<ComputeProps> | Effect.Effect<InputProps<ComputeProps>, never, PropsReq>,
  ): Effect.Effect<Compute, never, Providers | PropsReq>;
} = Platform<
  Compute,
  Effect.Error<ReturnType<typeof onCreate>>,
  Effect.Services<ReturnType<typeof onCreate>>
>(ComputeTypeId, {
  createRuntimeContext: (id): ComputeRuntimeContext => {
    const runners: Effect.Effect<void, never, unknown>[] = [];
    const env: Record<string, unknown> = {};
    let runtimeContext: ComputeRuntimeContext;
    const run: ProcessContext["run"] = (effect) =>
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
                handler.pipe(Effect.provideService(RuntimeContext, runtimeContext)),
              );
              return yield* Effect.never;
            }
          }),
        );
      });

    runtimeContext = {
      Type: ComputeTypeId,
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          // Prisma env keys are validated to the uppercase POSIX shape
          // ([A-Z_][A-Z0-9_]*), so the storage key is uppercased here. The
          // runtime `get` receives the key this returns, so both halves
          // agree without a second mapping.
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
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
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- runtime RuntimeContext.get must read process.env directly to avoid re-entering the ConfigProvider
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
      // `Platform` evaluates this after the init, also when the init returns
      // nothing, so the children the init's bindings need are declared here.
      exports: Effect.andThen(
        declareAfterInit(id, env),
        Effect.sync(() => ({
          default: Effect.forEach(
            // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- runners keep each program's own requirements; the host satisfies them when it runs `default`
            [...runners],
            // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- runners keep each program's own requirements; the host satisfies them when it runs `default`
            (effect) =>
              Effect.forever(
                // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- runners keep each program's own requirements; the host satisfies them when it runs `default`
                effect.pipe(
                  Effect.tapError((error) => Effect.logError(error)),
                  Effect.ignore,
                ),
              ),
            { concurrency: "unbounded" },
          ),
        })),
      ),
    };
    return runtimeContext;
  },
  onCreate: (resource, props) => onCreate(resource, props),
});

/** The sid of the binding through which the children report to the host. */
const COMPOSITION_SID = "Prisma.Compute.Composition";

/** Domain separator, so an environment digest is never the bare SHA-256 of a value. */
const ENVIRONMENT_DIGEST_SALT = "alchemy/Prisma.Compute/environment/v1";

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const EXPORT_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type EnvironmentInput = Record<string, unknown>;

/**
 * Check the props that are known while the program is evaluated, so a wrong
 * combination fails before anything is created.
 */
const validateDeclaredProps = Effect.fn(function* (props: ComputeProps, effectNative: boolean) {
  const invalid = (message: string) => Effect.fail(new ComputeInvalidProps({ message }));
  if (props.healthCheck !== undefined && !Output.isOutput(props.healthCheck)) {
    yield* validateComputeHealthCheck(props.healthCheck);
  }
  if (props.healthCheck !== undefined && props.verifyUrl === false) {
    return yield* invalid("healthCheck cannot be combined with verifyUrl: false.");
  }
  if (props.healthCheck !== undefined && props.start === false) {
    return yield* invalid("healthCheck requires start to be enabled.");
  }
  for (const [name, value] of [
    ["timeoutSeconds", props.timeoutSeconds],
    ["pollIntervalMs", props.pollIntervalMs],
    ["urlReadinessTimeoutSeconds", props.urlReadinessTimeoutSeconds],
  ] as const) {
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
      return yield* invalid(`${name} must be a positive finite number.`);
    }
  }
  for (const [name, value] of [
    ["port", props.port],
    ["dev.port", props.dev?.port],
  ] as const) {
    if (typeof value === "number" && (!Number.isInteger(value) || value < 1 || value > 65_535)) {
      return yield* invalid(`${name} must be an integer between 1 and 65535.`);
    }
  }
  for (const [key, value] of Object.entries(props.env ?? {})) {
    if (value === undefined) continue;
    if (key.length > 256 || !ENV_KEY_PATTERN.test(key)) {
      return yield* invalid(
        `Prisma environment variable key '${key}' must match POSIX env-var key shape: [A-Z_][A-Z0-9_]* and be at most 256 characters.`,
      );
    }
  }
  if ((props.skipPromote ?? false) && (props.destroyOldDeployment ?? false)) {
    return yield* invalid(
      "destroyOldDeployment cannot be combined with skipPromote because the previous version stays active when promotion is skipped.",
    );
  }
  if (props.start === false && !(props.skipPromote ?? false)) {
    return yield* invalid(
      "start: false requires skipPromote: true because Prisma Compute promotion requires a running version.",
    );
  }
  if (props.service !== undefined) {
    const owned = (
      ["project", "serviceName", "regionId", "branchId", "branchGitName", "envClass"] as const
    )
      .filter((name) => props[name] !== undefined)
      .join(", ");
    if (owned.length > 0) {
      return yield* invalid(
        `Prisma.Compute with service cannot also set ${owned}: those belong to the service.`,
      );
    }
    if (typeof props.service === "string" && !(props.skipPromote ?? false)) {
      return yield* invalid(
        "Prisma.Compute with a service ID requires skipPromote: true. A version can be attached as the active version only to a Prisma.ComputeService declared in this stack; pass that resource as service instead.",
      );
    }
  } else if (props.project === undefined) {
    return yield* invalid("Prisma.Compute requires project, or service.");
  }
  if (props.branchId !== undefined && props.branchGitName !== undefined) {
    return yield* invalid("branchId and branchGitName are mutually exclusive.");
  }
  if (props.branchId === null || props.branchGitName === null) {
    return yield* invalid(
      "Prisma.Compute requires an attached branch because a version reads its environment variables from the service's branch. Omit branchGitName to use the project's default branch, or set branchId/branchGitName.",
    );
  }
  if ((props.skipCodeUpload ?? false) && props.artifactPath !== undefined) {
    return yield* invalid("skipCodeUpload cannot be combined with artifactPath.");
  }
  if ((props.skipCodeUpload ?? false) && props.build !== undefined) {
    return yield* invalid("skipCodeUpload cannot be combined with build.");
  }
  if (effectNative) {
    const handler = props.handler ?? "default";
    if (handler !== "default" && !EXPORT_IDENTIFIER_PATTERN.test(handler)) {
      return yield* invalid(
        "Effect-native Prisma Compute handler must be `default` or a valid JavaScript export identifier.",
      );
    }
    if (props.main === undefined) {
      return yield* invalid(
        "Effect-native Prisma Compute apps require `main`. Set `main: import.meta.filename`.",
      );
    }
    if (props.artifactPath !== undefined) {
      return yield* invalid("Effect-native Prisma Compute apps cannot use artifactPath.");
    }
    if (props.build !== undefined) {
      return yield* invalid("Effect-native Prisma Compute apps cannot use build.");
    }
    if (props.skipCodeUpload) {
      return yield* invalid("Effect-native Prisma Compute apps cannot skip code upload.");
    }
  }
});

/** The keys that declare a variable: `null` and `undefined` declare none. */
const declaredKeys = (env: EnvironmentInput) =>
  Object.entries(env)
    .flatMap(([key, value]) => (value === null || value === undefined ? [] : [key]))
    .sort();

const toRedacted = (value: unknown): Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
    ? (value as Redacted.Redacted<string>)
    : Redacted.make(typeof value === "string" ? value : JSON.stringify(value));

/**
 * A variable's value once resolved. `undefined` or `null`, which an output can
 * resolve to, means no variable: `Prisma.EnvironmentVariable` then writes none
 * and deletes the one it wrote before.
 */
const variableValue = (value: unknown): Redacted.Redacted<string> | undefined =>
  value === undefined || value === null ? undefined : toRedacted(value);

const asOutput = (value: unknown): Output.Output<unknown> =>
  Output.isOutput(value) ? value : Output.literal(value);

/** A salted digest of a variable's value, the only form of it the version records. */
const environmentDigest = (key: string, value: unknown) =>
  Output.mapEffect((resolved: unknown) => {
    const redacted = variableValue(resolved);
    return sha256(
      redacted === undefined
        ? `${ENVIRONMENT_DIGEST_SALT}\0${key}\0absent`
        : `${ENVIRONMENT_DIGEST_SALT}\0${key}\0value\0${Redacted.value(redacted)}`,
    );
  })(asOutput(value));

const definedProps = <A extends Record<string, unknown>>(props: A) =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as {
    [K in keyof A]: Exclude<A[K], undefined>;
  };

/**
 * The service a Compute declares. Its logical ID on the platform is the
 * Compute's own, so `Prisma.Compute("api")` serves from the service `api`.
 */
const declareService = (host: Compute, props: ComputeProps) =>
  ComputeService(
    "Service",
    definedProps({
      project: props.project!,
      logicalId: defaultServiceLogicalId(host.FQN),
      envClass: props.envClass,
      displayName: props.serviceName,
      regionId: props.regionId,
      branchId: props.branchId,
      branchGitName: props.branchGitName,
      verifyUrl: props.verifyUrl,
      healthCheck: props.healthCheck,
      urlReadinessTimeoutSeconds: props.urlReadinessTimeoutSeconds,
      timeoutSeconds: props.timeoutSeconds,
      pollIntervalMs: props.pollIntervalMs,
    }),
  );

const serviceOf = (host: Compute, props: ComputeProps) =>
  props.service === undefined
    ? declareService(host, props)
    : Effect.succeed(
        typeof props.service === "string"
          ? ComputeService.lookup({ serviceId: props.service })
          : props.service,
      );

const isEffectNative = (props: ComputeProps, form: DeclarationForm) =>
  form === "class" && props.isExternal !== true;

type DeclarationForm = "external" | "class";

/** Declare the cloud children under the host's namespace and report them to it. */
const declareCloud = Effect.fn(function* (
  host: Compute,
  props: ComputeProps,
  env: EnvironmentInput,
  form: DeclarationForm,
) {
  const service = yield* serviceOf(host, props);
  const keys = declaredKeys(env);
  const variables = yield* Effect.forEach(keys, (key) =>
    EnvironmentVariable(`Env/${key}`, {
      project: service.projectId,
      // A service always has a Branch once `Prisma.ComputeService` has
      // reconciled it, and checks `envClass` against its role. A service
      // given by ID may have none; the variable then fails with a typed error.
      class: Output.map(service.branchRole, (role) => role!),
      branchId: Output.map(Output.all(service.branchRole, service.branchId), ([role, branchId]) =>
        role === "preview" && typeof branchId === "string" ? branchId : undefined,
      ),
      key,
      value: Output.map(asOutput(env[key]), variableValue),
    } satisfies InputProps<EnvironmentVariableProps>),
  );
  const effectNative = isEffectNative(props, form);
  const artifact =
    props.artifactPath === undefined && !(props.skipCodeUpload ?? false)
      ? yield* ComputeArtifact(
          "Artifact",
          definedProps({
            path: props.path,
            archiveIgnore: props.archiveIgnore,
            entrypoint: props.entrypoint,
            main: effectNative ? props.main : undefined,
            handler: effectNative ? props.handler : undefined,
            bundle: effectNative ? props.bundle : undefined,
            build: effectNative ? undefined : props.build,
            port: props.port,
            memo: props.memo,
          }),
        )
      : undefined;
  const serviceId: Output.Output<string> =
    typeof props.service === "string" ? Output.literal(props.service) : service.serviceId;
  // Variables are copied into a version when it is created, so the version
  // waits for them. The edge rides `service`: the only prop whose change of
  // resolution does not replace the version.
  const versionService =
    variables.length === 0
      ? serviceId
      : Output.flatMap(
          Output.all(serviceId, ...variables.map((variable) => Output.of(variable))),
          () => serviceId,
        );
  const environmentDigests = Object.fromEntries(
    keys.map((key) => [key, environmentDigest(key, env[key])]),
  );
  const version = yield* ComputeVersion(
    "Version",
    definedProps({
      service: versionService,
      artifactPath: artifact?.artifactPath ?? props.artifactPath,
      artifactContentType:
        artifact !== undefined || props.artifactPath !== undefined ? "application/gzip" : undefined,
      skipCodeUpload: props.skipCodeUpload,
      portMapping: { http: artifact?.defaultPort ?? props.port ?? 8080 },
      start: props.start,
      verifyUrl: props.verifyUrl,
      healthCheck: props.healthCheck,
      urlReadinessTimeoutSeconds: props.urlReadinessTimeoutSeconds,
      timeoutSeconds: props.timeoutSeconds,
      pollIntervalMs: props.pollIntervalMs,
      // The caller's map has its own key, so none of its keys can collide.
      triggers: {
        ...(props.triggers === undefined ? {} : { triggers: props.triggers }),
        environment: environmentDigests,
        ...(props.service === undefined
          ? {
              branch: {
                branchId: props.branchId ?? null,
                branchGitName: props.branchGitName ?? null,
              },
            }
          : {}),
      },
    }),
    // Set here, so a stack-wide policy neither deletes the versions the
    // platform's rollback returns to nor protects them from replacement.
  ).pipe(Effect.provideService(RemovalPolicy, props.destroyOldDeployment ? "destroy" : "retain"));
  const promoted = !(props.skipPromote ?? false);
  if (promoted && typeof props.service !== "string") {
    yield* activateVersion(service, version);
  }
  yield* host.bind(COMPOSITION_SID, {
    serviceId,
    serviceName: service.name,
    serviceEndpointDomain: service.serviceEndpointDomain,
    projectId: service.projectId,
    regionId: service.regionId,
    activeVersionId: service.activeVersionId,
    serviceUrl: service.url,
    versionId: version.versionId,
    versionUrl: version.url,
    versionEndpointDomain: version.previewDomain,
    environmentKeys: keys,
    promoted,
  });
});

/** The sid of the binding through which the dev process reports its URL. */
const DEV_PROCESS_SID = "Prisma.Compute.DevProcess";

/**
 * Under `alchemy dev`: the local process, and no cloud resource. The Compute
 * waits for the process to be ready by taking its URL.
 */
const declareDev = Effect.fn(function* (host: Compute, props: ComputeProps, env: EnvironmentInput) {
  const dev = props.dev;
  if (dev?.command === undefined) return;
  const port = dev.port ?? props.port;
  const devProcess = yield* Command.Dev(
    "Dev",
    definedProps({
      command: dev.command,
      cwd: dev.cwd ?? props.path,
      env: {
        NODE_ENV: "development",
        ...Object.fromEntries(
          declaredKeys(env).map((key) => [key, Output.map(asOutput(env[key]), variableValue)]),
        ),
        ...dev.env,
      },
      port,
    }),
  );
  yield* host.bind(DEV_PROCESS_SID, { devUrl: devProcess.url });
});

/**
 * Declare the children of `host`. Does nothing inside a deployed bundle,
 * where only the runtime runs.
 */
const declareChildren = Effect.fn(function* (
  host: Compute,
  props: ComputeProps,
  runtimeEnv: EnvironmentInput,
  form: DeclarationForm,
) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  // A value set by a binding overrides the same key in `env`.
  const env = { ...props.env, ...runtimeEnv };
  if (yield* isLocal) {
    yield* declareDev(host, props, env).pipe(Namespace.push(host.LogicalId));
  } else {
    yield* declareCloud(host, props, env, form).pipe(Namespace.push(host.LogicalId));
  }
});

/** Under `alchemy dev`, unless the Compute is piped through `Alchemy.remote()`. */
const isLocal = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  const remote = yield* ProviderModePolicy;
  return Option.isSome(context) && context.value.dev && remote !== true;
});

/**
 * The rest of a class-form Compute, declared once its init has set the
 * variables its bindings need. Keyed by the host resource, which the runtime
 * context finds again in the stack.
 */
const pendingCompositions = new WeakMap<
  object,
  (runtimeEnv: EnvironmentInput) => Effect.Effect<void>
>();

/**
 * Runs in `onCreate`, which both declaration forms call, so a wrong prop fails
 * the program before anything is created.
 */
const onCreate = (host: Compute, props: ComputeProps) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    // Only the form without an init registers its props with `isExternal`.
    const form: DeclarationForm = host.Props?.isExternal === true ? "external" : "class";
    yield* validateDeclaredProps(props, isEffectNative(props, form));
    if (form === "external") return yield* declareChildren(host, props, {}, form);
    if (!(yield* isLocal) && props.service === undefined) {
      yield* declareService(host, props).pipe(Namespace.push(host.LogicalId));
    }
    const services = yield* Effect.context<CompositionServices>();
    pendingCompositions.set(host, (runtimeEnv) =>
      declareChildren(host, props, runtimeEnv, form).pipe(Effect.provideContext(services)),
    );
  });

type CompositionServices = Effect.Services<ReturnType<typeof declareChildren>>;

/** Declare what the init's bindings needed, from the runtime context's `exports`. */
const declareAfterInit = (id: string, runtimeEnv: EnvironmentInput) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const stack = yield* Effect.serviceOption(StackContext);
    if (Option.isNone(stack)) return;
    const namespace = yield* CurrentNamespace;
    const host = stack.value.resources[toFqn(namespace, id)];
    const declare = host === undefined ? undefined : pendingCompositions.get(host);
    if (declare) yield* declare(runtimeEnv);
  });

const composedAttributes = (
  data: ComputeComposition,
): Omit<Compute["Attributes"], "local" | "composed"> => ({
  serviceId: data.serviceId,
  serviceName: data.serviceName,
  projectId: data.projectId,
  regionId: data.regionId,
  serviceEndpointDomain: data.serviceEndpointDomain,
  activeVersionId: data.activeVersionId,
  versionId: data.versionId,
  versionEndpointDomain: data.versionEndpointDomain ?? undefined,
  versionUrl: data.versionUrl,
  url: data.promoted ? data.serviceUrl : data.versionUrl,
  environmentKeys: data.environmentKeys,
});

const compositionOf = (bindings: unknown): ComputeComposition | undefined =>
  Array.isArray(bindings)
    ? (bindings as ReadonlyArray<ResourceBinding<ComputeComposition>>).find(
        (binding) => binding.sid === COMPOSITION_SID,
      )?.data
    : undefined;

/** Whether the composed provider wrote the row. */
const isComposed = (saved: object) => "composed" in saved && saved.composed === true;

/**
 * The refusal of a row the earlier provider wrote. `deploy` is the plan of a
 * deploy, which applies nothing; `delete` is its removal from the program or
 * `alchemy destroy`, which reach it after the run's other changes.
 */
const cannotUpgradeInPlace = Effect.fn(function* (fqn: string, when: "deploy" | "delete") {
  const stack = yield* Effect.serviceOption(Stack);
  const address = Option.match(stack, {
    onNone: () => `<stack>/<stage>/${fqn}`,
    onSome: ({ name, stage }) => `${name}/${stage}/${fqn}`,
  });
  return yield* new ComputeCannotUpgradeInPlace({
    message: [
      `Prisma.Compute '${fqn}' was deployed with an earlier release of @alchemy.run/prisma, from before Prisma.Compute declared its service, environment variables and version as separate resources. This release cannot take over that service in place.`,
      when === "deploy"
        ? "The deploy stopped while planning, so nothing was changed."
        : "The old service, its versions and its environment variables were neither changed nor deleted. Other changes in this run were applied.",
      "",
      "To keep deploying or destroy this stack as it is, use that earlier release: the last release before this change, listed in the changelog.",
      "",
      "To move to this release, which serves from a new service with a new URL:",
      `1. Run \`alchemy state delete ${address}\`. Alchemy forgets the old service. It keeps running on Prisma with its URL, its versions and its environment variables.`,
      "2. If the Compute sets serviceName, change it until the old service is deleted: a Branch cannot hold two services with one name.",
      "3. Deploy with `--adopt`, so the new environment variables take over the old service's variables of the same key, or delete those variables in the Prisma Console first. Without either, the deploy creates the new service and then stops at the first variable the old service holds; deploying again with `--adopt` continues from there.",
      "4. Move custom domains to the new service, and update anything that uses the old URL.",
      "5. Delete the old service in the Prisma Console once nothing uses it.",
      "",
      `To destroy the stack on this release instead: run \`alchemy state delete ${address}\`, then \`alchemy destroy\`. When the stack also declares the project, deleting the project deletes the old service with it; otherwise delete the old service in the Prisma Console.`,
    ].join("\n"),
  });
});

/** The attributes whose new values are known and unchanged keep their old values in the plan. */
const unchangedAttributes = (output: Compute["Attributes"], data: unknown) => {
  if (typeof data !== "object" || data === null) return [];
  const next = data as Partial<ComputeComposition>;
  const candidates: Array<[keyof Compute["Attributes"], unknown]> = [
    ["serviceId", next.serviceId],
    ["serviceName", next.serviceName],
    ["projectId", next.projectId],
    ["regionId", next.regionId],
    ["serviceEndpointDomain", next.serviceEndpointDomain],
    ["activeVersionId", next.activeVersionId],
    ["versionId", next.versionId],
    ["versionUrl", next.versionUrl],
    ["versionEndpointDomain", next.versionEndpointDomain ?? undefined],
    ["environmentKeys", next.environmentKeys],
    // Derived as `composedAttributes` derives it, from whichever URL serves.
    [
      "url",
      next.promoted === undefined ? undefined : next.promoted ? next.serviceUrl : next.versionUrl,
    ],
  ];
  return candidates.flatMap(([name, value]) =>
    isResolved(value) && deepEqual(value, output[name]) ? [name] : [],
  );
};

const ProviderLive = () =>
  Provider.effect(
    Compute,
    Effect.gen(function* () {
      return {
        stables: [],
        // The children own the platform objects; the service enumerates them.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ fqn, output, newBindings }) {
          if (output && !isComposed(output)) return yield* cannotUpgradeInPlace(fqn, "deploy");
          if (!output) return undefined;
          return {
            action: "update",
            stables: unchangedAttributes(output, compositionOf(newBindings)),
          } as const;
        }),
        reconcile: Effect.fn(function* ({ fqn, output, bindings }) {
          if (output && !isComposed(output)) return yield* cannotUpgradeInPlace(fqn, "deploy");
          const data = compositionOf(bindings);
          if (!data) {
            return yield* new ComputeOperationFailed({
              message: `Prisma.Compute '${fqn}' received nothing from its service and version. It is declared in the cloud only through Prisma.Compute, which declares them.`,
            });
          }
          return { ...composedAttributes(data), local: false, composed: true } as const;
        }),
        // Deleting the children removes the platform objects. A row of the
        // earlier provider is refused: its delete removed the service.
        delete: Effect.fn(function* ({ fqn, output }) {
          if (!isComposed(output)) return yield* cannotUpgradeInPlace(fqn, "delete");
        }),
        tail: ({ output }) =>
          output.versionId ? tailDeploymentLogs(output.versionId) : Stream.empty,
      };
    }),
  );

/** Under `alchemy dev` the host reports the local URL; `Command.Dev` runs the process. */
export const ComputeDevProvider = () =>
  Provider.effect(
    Compute,
    Effect.gen(function* () {
      return {
        stables: ["serviceId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* () {
          return { action: "update" } as const;
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings }) {
          const port = news.dev?.port ?? news.port;
          const devUrl = bindings.find((binding) => binding.sid === DEV_PROCESS_SID)?.data;
          const url =
            news.dev?.url ??
            (devUrl && "devUrl" in devUrl ? devUrl.devUrl : undefined) ??
            (port ? `http://localhost:${port}` : undefined);
          const service = news.service as unknown;
          const projectId =
            news.project !== undefined
              ? yield* resolveProjectId(news.project)
              : typeof service === "object" && service !== null && "projectId" in service
                ? String(service.projectId)
                : `dev:project:${id}`;
          return {
            serviceId: `dev:${id}`,
            serviceName: news.serviceName ?? id,
            projectId,
            regionId: news.regionId ?? "us-east-1",
            serviceEndpointDomain: url,
            activeVersionId: null,
            versionId: undefined,
            versionEndpointDomain: url,
            versionUrl: url,
            url,
            environmentKeys: declaredKeys(news.env ?? {}),
            local: true,
            composed: true,
          } as const;
        }),
        delete: () => Effect.void,
      };
    }),
  );

export const ComputeProvider = () =>
  ProviderLayer.dual(Compute, {
    local: () => ComputeDevProvider(),
    live: () => ProviderLive(),
  });
