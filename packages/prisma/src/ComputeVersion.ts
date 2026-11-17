import { Retry } from "@distilled.cloud/prisma";
import {
  type GetServiceDeploymentsResponse,
  getServiceDeployments,
  createServiceDeployment,
  getService,
} from "@distilled.cloud/prisma/management";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { initialCwd } from "alchemy/Util/Node";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  destroyComputeVersion,
  PrismaComputeVersionWaitTimeout,
  toComputeUrl,
  waitForComputeVersionStatus,
} from "./ComputeLifecycle.ts";
import type { ComputeService } from "./ComputeService.ts";
import {
  inspectArtifactFile,
  findArchiveManifest,
  readArtifactFile,
  type ArtifactFile,
} from "./internal/ArtifactFile.ts";
import { isContentNamedArchive } from "./internal/ArtifactStore.ts";
import { executeArtifactUpload } from "./internal/ArtifactUpload.ts";
import { startDeploymentIdempotent } from "./internal/DeploymentActions.ts";
import { observeDeployment } from "./internal/DeploymentObserve.ts";
import { DEV_TIMESTAMP, attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import type { ObservedDeployment } from "./internal/Observed.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveServiceId,
  unresolvedServiceIdOf,
} from "./internal/Refs.ts";
import { updateRowSavedBeforeRename } from "./internal/RenamedState.ts";
import { type ComputeHealthCheck, waitForComputeUrl } from "./internal/UrlCheck.ts";
import { ensureVersionMembership } from "./internal/VersionIdentity.ts";
import { tailDeploymentLogs } from "./PrismaLogs.ts";
import type { Providers } from "./Providers.ts";

export class ComputeVersionConflict extends Data.TaggedError("ComputeVersionConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeVersionInvalidProps extends Data.TaggedError("ComputeVersionInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A version this deploy created failed, and Alchemy could not remove it.
 * `errors` holds the failure, then the reason the version was not removed.
 */
export class ComputeVersionNotRemoved extends Data.TaggedError("ComputeVersionNotRemoved")<{
  readonly message: string;
  readonly errors: readonly [failure: unknown, cleanupError: unknown];
  readonly cause?: unknown;
}> {}

/**
 * How long a failed version's removal waits for the version to stop: 30
 * seconds, or `timeoutSeconds` when that is shorter.
 */
const cleanupStopWaitSeconds = (props: { readonly timeoutSeconds?: number }) =>
  Math.min(30, props.timeoutSeconds ?? 30);

const messageOf = (error: unknown) =>
  error instanceof Error || (typeof error === "object" && error !== null && "message" in error)
    ? String((error as { message: unknown }).message)
    : String(error);

const versionNotRemovedMessage = (
  versionId: string,
  waitedSeconds: number,
  failure: unknown,
  cleanupError: unknown,
) => {
  const reason =
    cleanupError instanceof PrismaComputeVersionWaitTimeout
      ? `the platform was still stopping it after ${waitedSeconds} s, and only a stopped version can be deleted`
      : `deleting it failed: ${messageOf(cleanupError).replace(" Run the command again, or delete the version in the Prisma Console.", "").replace(/\.$/, "")}`;
  return `${messageOf(failure).replace(/\.$/, "")}. Alchemy then stopped Prisma Compute version '${versionId}', which this deploy created, to remove it, but ${reason}. The version is not served, and Alchemy no longer tracks it: delete it in the Prisma Console once it has stopped.`;
};

export class ComputeVersionOperationFailed extends Data.TaggedError(
  "ComputeVersionOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeVersionUnexpectedResponse extends Data.TaggedError(
  "ComputeVersionUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const MAX_COMPUTE_VERSION_ARTIFACT_BYTES = 768 * 1024 * 1024;

export interface ComputeVersionProps {
  /**
   * Compute service ID or `Prisma.ComputeService` resource that owns this
   * version.
   */
  service: string | ComputeService;
  /**
   * Port mapping for the version. Set `http` to `null` to reset to
   * Foundry's default port (8080); non-null values must be integers from
   * 1 through 65535.
   */
  portMapping?: { http?: number | null };
  /**
   * Create the version by reusing the service's currently promoted artifact
   * instead of uploading code. Requires an existing promoted version.
   */
  skipCodeUpload?: boolean;
  /**
   * Path to a pre-created artifact file to upload to the pre-signed upload URL.
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
   * Content type for artifact uploads.
   *
   * @default "application/octet-stream"
   */
  artifactContentType?: string;
  /**
   * Start the version after it is created. A version must be running before
   * it can become a service's active version (see `Prisma.activateVersion`).
   * Set `false` to create a version that is not started.
   *
   * @default true
   */
  start?: boolean;
  /**
   * After the version starts, wait until its preview URL answers on Prisma's
   * edge. With `healthCheck`, also wait until that path returns an accepted
   * status. A version this deploy created is deleted when the check fails.
   * Has no effect with `start: false`.
   *
   * @default true
   */
  verifyUrl?: boolean;
  /**
   * Application path probed on the version's preview URL after it starts.
   * Cannot be combined with `start: false` or `verifyUrl: false`.
   *
   * @example
   * ```typescript
   * healthCheck: { path: "/api/health", statusCodes: [200] }
   * ```
   */
  healthCheck?: ComputeHealthCheck;
  /**
   * Maximum seconds to wait for the preview URL to answer.
   *
   * @default 60
   */
  urlReadinessTimeoutSeconds?: number;
  /**
   * Maximum seconds to wait for the version to report `running`. A version
   * this deploy created that then fails is stopped and deleted, waiting up to
   * 30 seconds, or this value when it is shorter, for it to stop.
   *
   * @default 120
   */
  timeoutSeconds?: number;
  /**
   * Milliseconds between status and URL probes.
   *
   * @default 1000
   */
  pollIntervalMs?: number;
  /**
   * Opaque key/value map; when any resolved value changes, a new version is
   * created even if the artifact is unchanged — the same contract as
   * `AWS.ApiGateway.Deployment.triggers`. The version compares a salted hash
   * of the values, recorded as `triggersHash`. The map itself is stored in
   * Alchemy state as a prop, and a `Redacted` member is stored there as plain
   * text inside a redaction marker, so pass a digest of a secret rather than
   * the secret, as `Prisma.Compute` does for its environment variables.
   *
   * Prisma snapshots environment variables into a deployment when the
   * deployment is created, so changing only an environment variable's value
   * updates the platform's variable record but never reaches the running app.
   * Pass those values here to make such a change take effect.
   *

   * If the value cannot be resolved while the deploy is being planned —
   * because it reads an attribute of another resource that the same deploy is
   * changing — the diff cannot prove the fingerprint is unchanged, and the
   * engine offers no later opportunity to plan a replacement. The deployment
   * is then replaced conservatively, but only once a fingerprint has already
   * been recorded: adding `triggers` to an existing deployment records its
   * fingerprint through a plain update rather than forcing a replacement.
   *
   * Leaving `triggers` unset tracks nothing, so removing it from a
   * deployment that had it does not trigger a replacement on its own.
   *
   * @example
   * ```typescript
   * const version = yield* Prisma.ComputeVersion("web", {
   *   service,
   *   artifactPath: "./dist/app.tar.gz",
   *   triggers: { schemaVersion: "42" },
   * });
   * ```
   */
  triggers?: Record<string, unknown>;
}

export interface ComputeVersion extends Resource<
  "Prisma.ComputeVersion",
  ComputeVersionProps,
  {
    /**
     * Prisma Compute version ID. The Management API calls it a deployment ID.
     */
    versionId: string;
    /**
     * Compute service ID that owns the version.
     */
    serviceId: string;
    /**
     * Foundry version ID returned by the Prisma Management API.
     */
    foundryVersionId: string;
    /**
     * Current deployment status, when observed.
     */
    status: string | undefined;
    /**
     * Preview endpoint domain for the deployment.
     */
    previewDomain: string | null | undefined;
    /**
     * Hash of the artifact bytes uploaded for this deployment, when Alchemy
     * uploaded an artifact.
     */
    artifactHash?: string;
    /**
     * Salted fingerprint of the resolved `triggers` inputs this deployment
     * was created for. Held `Redacted` so the inputs stay out of plaintext
     * state; absent when `triggers` is unset.
     */
    triggersHash?: Redacted.Redacted<string>;
    /**
     * HTTPS URL of the version's preview endpoint, when it has one.
     */
    url: string | undefined;
    /**
     * ISO timestamp when the deployment was created, when observed.
     */
    createdAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A version of a Prisma Compute service: one uploaded or reused artifact. The
 * Management API calls a version a deployment.
 *
 * A version is immutable. Changing its artifact, `artifactPath`,
 * `artifactContentType`, `portMapping`, `skipCodeUpload` or `triggers`
 * creates a new version. An `artifactPath` that another resource produces in
 * the same deploy also creates a new version, because the new artifact is not
 * known while the deploy is planned.
 *
 * A version does not make itself live. Attach it to its service with
 * `Prisma.activateVersion`; the service then promotes it and checks its
 * stable endpoint. Prefer `Prisma.Compute` for production application
 * deployments.
 *
 * :::caution
 * A replaced version is kept on the platform, and so is a version removed
 * from the program or left behind by `alchemy destroy`: Alchemy forgets it
 * without deleting it, so the platform can roll the service back to it. The
 * service's own delete removes its versions. Pipe `RemovalPolicy.destroy()`
 * onto the resource to delete superseded versions instead. The version the
 * service serves is never deleted on its own, whatever the policy: Alchemy
 * forgets it, and deleting the service removes it.
 * :::
 *
 * Prisma's create-deployment API currently exposes neither an idempotency key
 * nor a caller-defined natural key. After a crash that loses state immediately
 * after creation, Alchemy deliberately does not adopt the service's latest
 * version: doing so could take ownership of an unrelated version. When
 * persisted state contains a Foundry version ID, refresh may safely recover the
 * matching version.
 *
 * This resource was named `Prisma.Deployment`. State saved under that type is
 * still read, and is rewritten under the new type on the next deploy.
 *
 * ### Creating a Version
 * **Example:** Upload a prebuilt artifact and make it the active version
 * ```typescript
 * const service = yield* Prisma.ComputeService("web", { project });
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   service: service.serviceId,
 *   artifactPath: "./dist/app.tar.gz",
 *   artifactContentType: "application/gzip",
 * });
 * yield* Prisma.activateVersion(service, version);
 * ```
 *
 * **Example:** Fork the currently promoted artifact
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-fork", {
 *   service: service.serviceId,
 *   skipCodeUpload: true,
 * });
 * ```
 *
 * ### Checking the Version
 * **Example:** Wait for a health route on the preview URL
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   service: service.serviceId,
 *   artifactPath: "./dist/app.tar.gz",
 *   healthCheck: { path: "/api/health" },
 * });
 * ```
 *
 * ### Shipping Environment Changes
 * Prisma copies the Branch's environment variables into a version when it
 * creates it. A changed value reaches the app only in a new version, so put
 * what must ship a new version in `triggers`. `Prisma.Compute` does this for
 * the variables it declares.
 *
 * **Example:** Create a new version when a variable's value changes
 * ```typescript
 * const logLevel = "debug";
 * const variable = yield* Prisma.EnvironmentVariable("log-level", {
 *   project,
 *   class: "production",
 *   key: "LOG_LEVEL",
 *   value: Redacted.make(logLevel),
 * });
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   // Created after the variable is written, so it copies the new value.
 *   service: Output.map(
 *     Output.all(service.serviceId, Output.of(variable)),
 *     ([serviceId]) => serviceId,
 *   ),
 *   artifactPath: "./dist/app.tar.gz",
 *   triggers: { LOG_LEVEL: logLevel },
 * });
 * yield* Prisma.activateVersion(service, version);
 * ```
 *
 * ### Deleting Superseded Versions
 * **Example:** Delete a replaced version instead of keeping it
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   service: service.serviceId,
 *   artifactPath: "./dist/app.tar.gz",
 * }).pipe(RemovalPolicy.destroy());
 * ```
 *
 * @resource
 * @product Compute
 */
export const ComputeVersion = Resource<ComputeVersion>("Prisma.ComputeVersion", {
  aliases: ["Prisma.Deployment"],
  defaultRemovalPolicy: "retain",
});

/** Attributes as `Prisma.Deployment` wrote them, before the rename. */
interface LegacyComputeVersionAttributes extends Omit<
  ComputeVersion["Attributes"],
  "versionId" | "serviceId" | "url"
> {
  deploymentId: string;
  appId: string;
  appEndpointDomain: string | undefined;
}

type SavedAttributes = ComputeVersion["Attributes"] | LegacyComputeVersionAttributes;

/** Read attributes saved before or after the rename under the current names. */
function currentAttributes(saved: SavedAttributes): ComputeVersion["Attributes"] {
  if ("versionId" in saved) return saved;
  const { deploymentId, appId, appEndpointDomain: _promotedTo, ...rest } = saved;
  return {
    ...rest,
    versionId: deploymentId,
    serviceId: appId,
    url: toComputeUrl(rest.previewDomain),
  };
}

/** Props as `Prisma.Deployment` took them, before `app` became `service`. */
type LegacyComputeVersionProps = Omit<ComputeVersionProps, "service"> & {
  app: ComputeVersionProps["service"];
};

/** Read props saved before or after the rename under the current names. */
const currentProps = (olds: ComputeVersionProps | LegacyComputeVersionProps) => {
  if ("service" in olds) return olds;
  const { app, ...rest } = olds;
  return { ...rest, service: app };
};

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listAppDeployments = (serviceId: string) =>
  Effect.gen(function* () {
    const deployments: GetServiceDeploymentsResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getServiceDeployments(
        cursor === undefined ? { serviceId, limit: 100 } : { serviceId, limit: 100, cursor },
      );
      deployments.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getServiceDeployments: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return deployments;
  });

const findDeployment = (serviceId: string, foundryVersionId: string | undefined) =>
  foundryVersionId === undefined
    ? Effect.undefined
    : listAppDeployments(serviceId).pipe(
        Effect.flatMap((deployments) => {
          const matches = deployments.filter(
            (deployment) => deployment.foundryVersionId === foundryVersionId,
          );
          return matches.length > 1
            ? Effect.fail(
                new ComputeVersionConflict({
                  message: `Prisma returned multiple deployments with Foundry version ID '${foundryVersionId}' for Compute service '${serviceId}'; refusing an ambiguous recovery match.`,
                }),
              )
            : Effect.succeed(matches[0]);
        }),
      );

const attrsFrom = (
  deployment: ObservedDeployment,
  serviceId: string,
  extra?: {
    artifactHash?: string;
    triggersHash?: Redacted.Redacted<string>;
  },
): ComputeVersion["Attributes"] => ({
  versionId: deployment.id,
  serviceId,
  foundryVersionId: deployment.foundryVersionId,
  status: deployment.status,
  previewDomain: deployment.previewDomain,
  artifactHash: extra?.artifactHash,
  triggersHash: extra?.triggersHash,
  url: toComputeUrl(deployment.previewDomain),
  createdAt: deployment.createdAt,
});

export class InvalidArtifactUploadUrlError extends Data.TaggedError(
  "InvalidArtifactUploadUrlError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ReadUploadArtifactInput {
  artifact?: string | Uint8Array;
  artifactPath?: string;
  output?: "bytes" | "file";
}

type ReadUploadArtifactError = Effect.Error<ReturnType<typeof readUploadArtifactInternal>>;

export function readUploadArtifact(
  input: ReadUploadArtifactInput & { readonly output: "file" },
): Effect.Effect<ArtifactFile | undefined, ReadUploadArtifactError, Path.Path>;
export function readUploadArtifact(
  input: ReadUploadArtifactInput & { readonly output?: "bytes" },
): Effect.Effect<Uint8Array | undefined, ReadUploadArtifactError, Path.Path>;
export function readUploadArtifact(
  input: ReadUploadArtifactInput,
): Effect.Effect<Uint8Array | ArtifactFile | undefined, ReadUploadArtifactError, Path.Path>;
export function readUploadArtifact(input: ReadUploadArtifactInput) {
  return readUploadArtifactInternal(input);
}

const readUploadArtifactInternal = Effect.fn(function* (input: ReadUploadArtifactInput) {
  if (input.artifact !== undefined && input.artifactPath !== undefined) {
    return yield* new ComputeVersionInvalidProps({
      message: "artifact and artifactPath are mutually exclusive.",
    });
  }
  if (input.output === "file" && input.artifact !== undefined) {
    return yield* new ComputeVersionInvalidProps({
      message: "File-backed artifact output requires artifactPath.",
    });
  }
  if (input.artifactPath !== undefined) {
    const path = yield* Path.Path;
    const resolved = path.resolve(initialCwd, input.artifactPath);
    const artifact = yield* inspectArtifactFile(resolved, MAX_COMPUTE_VERSION_ARTIFACT_BYTES);
    if (input.output === "file") {
      return artifact;
    }
    return yield* readArtifactFile(artifact);
  }
  if (input.artifact !== undefined) {
    const artifact = input.artifact;
    const bytes = yield* Effect.sync(() =>
      typeof artifact === "string" ? new TextEncoder().encode(artifact) : artifact,
    );
    return yield* validateComputeVersionArtifactBytes(bytes);
  }
  return undefined;
});

export const validateComputeVersionArtifactBytes = (
  artifact: Uint8Array,
  maxBytes = MAX_COMPUTE_VERSION_ARTIFACT_BYTES,
) =>
  !Number.isSafeInteger(maxBytes) || maxBytes <= 0
    ? Effect.fail(
        new ComputeVersionInvalidProps({
          message: "Artifact maxBytes must be a positive safe integer.",
        }),
      )
    : maxBytes > MAX_COMPUTE_VERSION_ARTIFACT_BYTES
      ? Effect.fail(
          new ComputeVersionInvalidProps({
            message: `Artifact maxBytes must not exceed the hard limit of ${MAX_COMPUTE_VERSION_ARTIFACT_BYTES}.`,
          }),
        )
      : artifact.byteLength === 0
        ? Effect.fail(
            new ComputeVersionInvalidProps({
              message: "Prisma deployment artifact must be non-empty.",
            }),
          )
        : artifact.byteLength > maxBytes
          ? Effect.fail(
              new ComputeVersionInvalidProps({
                message: `Prisma deployment artifact exceeds the ${maxBytes} byte upload safety limit.`,
              }),
            )
          : Effect.succeed(artifact);

const artifactHashOf = Effect.fn(function* (props: ComputeVersionProps) {
  const artifact = yield* readUploadArtifact({
    artifactPath: props.artifactPath,
    output: "file",
  });
  if (artifact === undefined) return undefined;
  return yield* sha256Object({
    artifact: artifact.sha256,
    contentType: props.artifactContentType ?? "application/octet-stream",
  });
});

/**
 * A `tar.gz` artifact must hold `compute.manifest.json` at its root, which
 * names the entrypoint. Refused before any version is created, because the
 * platform starts an archive without one and its URL never answers.
 */
const requireComputeManifest = Effect.fn(function* (
  artifactPath: string,
  artifact: ArtifactFile,
  contentType: string | undefined,
) {
  const check = yield* findArchiveManifest(artifact);
  const format =
    'A Prisma Compute artifact is a tar.gz archive with compute.manifest.json at its root, {"manifestVersion": "1", "entrypoint": "<path of the server file in the archive>"}. createComputeArchive from @alchemy.run/prisma/ComputeArchive builds one, and Prisma.ComputeArtifact builds one from a directory.';
  if (check._tag === "NotGzip") {
    if (contentType !== "application/gzip") return;
    return yield* new ComputeVersionInvalidProps({
      message: `artifactPath '${artifactPath}' is not gzip-compressed. ${format}`,
    });
  }
  if (check._tag === "Missing") {
    return yield* new ComputeVersionInvalidProps({
      message: `artifactPath '${artifactPath}' has no compute.manifest.json at its root. ${format}`,
    });
  }
  if (check._tag === "Invalid") {
    return yield* new ComputeVersionInvalidProps({
      message: `artifactPath '${artifactPath}' has a compute.manifest.json that cannot be used: ${check.reason}. ${format}`,
    });
  }
});

/**
 * Whether an unchanged `artifactPath` names an archive that is not on this
 * machine, such as a CI runner that did not build it. An archive named by
 * its SHA-256 holds the bytes its name says, so the version that uploaded it
 * needs neither the file nor a new upload.
 */
const pinnedArchiveMissing = Effect.fn(function* (
  artifactPath: string | undefined,
  savedArtifactPath: string | undefined,
) {
  if (artifactPath === undefined || artifactPath !== savedArtifactPath) return false;
  if (!(yield* isContentNamedArchive(artifactPath))) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return !(yield* fs.exists(path.resolve(initialCwd, artifactPath)));
});

/**
 * Domain separator so a `triggers` fingerprint is never the bare SHA-256 of
 * a secret value, which would otherwise be comparable against a precomputed
 * digest of a guessed value.
 */
const TRIGGERS_HASH_SALT = "alchemy/Prisma.Deployment/triggers/v1";

const unwrapRedacted = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return value.pipe(Redacted.value, unwrapRedacted);
  if (Array.isArray(value)) return value.map(unwrapRedacted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unwrapRedacted(item)]),
    );
  }
  return value;
};

const triggersHashOf = (triggers: unknown) =>
  sha256Object({
    salt: TRIGGERS_HASH_SALT,
    triggers: unwrapRedacted(triggers) ?? null,
  });

const persistedTriggersHash = (value: Redacted.Redacted<string> | string | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Whether the declared `triggers` inputs differ from the fingerprint the
 * running deployment was created for.
 *
 * Only `diff` can plan a replacement — `reconcile` has no way to ask for one —
 * so an input that is still unresolved while planning is treated as changed.
 * That is only reached when another resource in the same deploy owns the
 * value and is itself changing, in which case the value most likely changed
 * too; the cost of being wrong is one extra create-before-delete replacement.
 * Without a recorded fingerprint there is nothing to compare against, so the
 * first deploy that declares `triggers` records it through the engine's
 * default update instead of replacing the deployment.
 */
const triggersChanged = Effect.fn(function* (
  triggers: unknown,
  persisted: Redacted.Redacted<string> | string | undefined,
) {
  const recorded = persistedTriggersHash(persisted);
  if (triggers === undefined || recorded === undefined) return false;
  if (!isResolved({ triggers })) return true;
  return (yield* triggersHashOf(triggers)) !== recorded;
});

export const uploadArtifact = (
  uploadUrl: string,
  artifact: Uint8Array | ArtifactFile,
  contentType: string,
) =>
  Effect.gen(function* () {
    if (artifact instanceof Uint8Array) {
      yield* validateComputeVersionArtifactBytes(artifact);
    } else if (artifact.size <= 0 || artifact.size > MAX_COMPUTE_VERSION_ARTIFACT_BYTES) {
      return yield* new ComputeVersionInvalidProps({
        message: `Prisma deployment artifact exceeds the ${MAX_COMPUTE_VERSION_ARTIFACT_BYTES} byte upload safety limit.`,
      });
    }
    yield* Effect.try({
      try: () => {
        const parsed = new URL(uploadUrl);
        if (
          parsed.protocol !== "https:" ||
          parsed.username.length > 0 ||
          parsed.password.length > 0
        ) {
          throw new Error("invalid upload URL");
        }
      },
      catch: (cause) =>
        new InvalidArtifactUploadUrlError({
          message: "Prisma artifact upload URL must be credential-free HTTPS.",
          cause,
        }),
    });
    yield* executeArtifactUpload(uploadUrl, artifact, contentType);
  });

const ProviderLive = () =>
  Provider.effect(
    ComputeVersion,
    Effect.gen(function* () {
      return {
        stables: ["versionId"],
        // Service deletion cascades versions. ComputeServiceProvider is the single nuke
        // enumerator so a version is never deleted twice during teardown.
        list: () => Effect.succeed([]),
        diff: Effect.fn(
          function* ({ olds: savedProps, news, output: saved }) {
            if (!isInputObject(news)) return undefined;
            const output = saved && currentAttributes(saved);
            const olds = currentProps(savedProps);
            if (isPrismaDevId(output?.versionId)) {
              return { action: "update" } as const;
            }
            // `versionId` is stable and Foundry's failed status is terminal.
            // Route drift recovery through the engine's create-before-delete
            // replacement lifecycle instead of trying to restart the failed
            // generation or changing a stable ID during an update.
            if (output?.status === "failed") {
              return { action: "replace" } as const;
            }
            // Checked before the resolved-content early return below: a
            // deferred diff falls back to an update, which reuses the running
            // deployment and would never apply the changed inputs.
            if (yield* triggersChanged(news.triggers, output?.triggersHash)) {
              return { action: "replace" } as const;
            }
            // An artifact another resource builds in this deploy is unknown
            // here. Only a new version ships it: an update would keep the
            // running version and record the new artifact's hash.
            if (!isResolved({ path: news.artifactPath, type: news.artifactContentType })) {
              return { action: "replace" } as const;
            }
            const replacementContent = {
              portMapping: news.portMapping,
              skipCodeUpload: news.skipCodeUpload,
              artifactPath: news.artifactPath,
              artifactContentType: news.artifactContentType,
            };
            if (!isResolved(replacementContent)) return undefined;
            const resolvedReplacementContent = replacementContent as Pick<
              ComputeVersionProps,
              "portMapping" | "skipCodeUpload" | "artifactPath" | "artifactContentType"
            >;
            const oldServiceId = output?.serviceId ?? unresolvedServiceIdOf(olds.service);
            const newServiceId = isResolved(news.service)
              ? unresolvedServiceIdOf(news.service)
              : undefined;
            const oldArtifactHash = output?.artifactHash;
            const newArtifactHash = (yield* pinnedArchiveMissing(
              resolvedReplacementContent.artifactPath,
              olds.artifactPath,
            ))
              ? undefined
              : yield* artifactHashOf({
                  service: olds.service,
                  ...resolvedReplacementContent,
                });
            const serviceChanged = concreteIdsChanged(oldServiceId, newServiceId);
            if (
              serviceChanged ||
              !deepEqual(resolvedReplacementContent.portMapping ?? {}, olds.portMapping ?? {}) ||
              (resolvedReplacementContent.skipCodeUpload ?? false) !==
                (olds.skipCodeUpload ?? false) ||
              resolvedReplacementContent.artifactPath !== olds.artifactPath ||
              resolvedReplacementContent.artifactContentType !== olds.artifactContentType ||
              (newArtifactHash !== undefined && newArtifactHash !== oldArtifactHash)
            ) {
              return { action: "replace" } as const;
            }
            if (!isResolved(news.start)) return undefined;
            if (news.start ?? true) {
              // Reconcile asserts the running state on every deploy, so an
              // external stop is repaired.
              return { action: "update" } as const;
            }
            if (olds.start ?? true) return { action: "update" } as const;
            return undefined;
          },
          (effect, { output: saved }) =>
            effect.pipe(
              Effect.map((diff) =>
                updateRowSavedBeforeRename(saved !== undefined && !("versionId" in saved), diff),
              ),
            ),
        ),
        read: Effect.fn(function* ({ output: saved, olds: savedProps }) {
          const output = saved && currentAttributes(saved);
          const olds = currentProps(savedProps);
          if (isPrismaDevId(output?.versionId)) return undefined;
          const serviceId =
            output?.serviceId && !isPrismaDevId(output.serviceId)
              ? output.serviceId
              : yield* resolveServiceId(olds.service);
          const savedDeployment = output?.versionId
            ? yield* observeDeployment(output.versionId).pipe(
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          const listed = savedDeployment
            ? undefined
            : yield* findDeployment(serviceId, output?.foundryVersionId);
          const deployment =
            savedDeployment ?? (listed ? yield* observeDeployment(listed.id) : undefined);
          if (savedDeployment) {
            yield* ensureVersionMembership(serviceId, savedDeployment);
          }
          return deployment ? attrsFrom(deployment, serviceId, output) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, olds: savedProps, output: saved, session }) {
          const note = (message: string) =>
            session === undefined ? Effect.void : session.note(message);
          const output = saved && currentAttributes(saved);
          if (
            news.portMapping?.http !== undefined &&
            news.portMapping.http !== null &&
            (!Number.isInteger(news.portMapping.http) ||
              news.portMapping.http < 1 ||
              news.portMapping.http > 65_535)
          ) {
            return yield* new ComputeVersionInvalidProps({
              message: "portMapping.http must be an integer between 1 and 65535.",
            });
          }
          if (!(news.skipCodeUpload ?? false) && news.artifactPath === undefined) {
            return yield* new ComputeVersionInvalidProps({
              message: "Prisma.ComputeVersion requires artifactPath or skipCodeUpload: true.",
            });
          }
          if ((news.skipCodeUpload ?? false) && news.artifactPath !== undefined) {
            return yield* new ComputeVersionInvalidProps({
              message: "skipCodeUpload cannot be combined with artifactPath.",
            });
          }
          if (news.healthCheck !== undefined && news.start === false) {
            return yield* new ComputeVersionInvalidProps({
              message: "healthCheck cannot be combined with start: false.",
            });
          }
          const serviceId = yield* resolveServiceId(news.service);
          const deploymentId = isPrismaDevId(output?.versionId) ? undefined : output?.versionId;
          let deployment: ObservedDeployment | undefined = deploymentId
            ? yield* observeDeployment(deploymentId).pipe(
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          // The existing version already holds these bytes; only a new
          // version needs the file.
          const artifact =
            deployment !== undefined &&
            (yield* pinnedArchiveMissing(
              news.artifactPath,
              savedProps === undefined ? undefined : currentProps(savedProps).artifactPath,
            ))
              ? undefined
              : yield* readUploadArtifact({
                  artifactPath: news.artifactPath,
                  output: "file",
                });
          if (artifact !== undefined) {
            yield* requireComputeManifest(news.artifactPath!, artifact, news.artifactContentType);
          }
          const artifactHash =
            artifact === undefined
              ? output?.artifactHash
              : yield* sha256Object({
                  artifact: artifact.sha256,
                  contentType: news.artifactContentType ?? "application/octet-stream",
                });
          const triggersHash =
            news.triggers === undefined
              ? undefined
              : Redacted.make(yield* triggersHashOf(news.triggers));
          if (deployment) {
            yield* ensureVersionMembership(serviceId, deployment);
            if (deployment.status === "failed") {
              return yield* new ComputeVersionOperationFailed({
                message: `Prisma deployment '${deployment.id}' is in terminal status 'failed' and must be replaced before reconcile; refusing to restart it or change the stable versionId during an update.`,
              });
            }
          }
          let createdDeploymentId: string | undefined;
          // A version created by this reconcile that then fails is not in
          // state, so it is removed here or not at all.
          const cleanupCreatedDeploymentOnFailure = <E>(failedDeploymentId: string, error: E) =>
            createdDeploymentId === failedDeploymentId
              ? note(
                  `Version '${failedDeploymentId}' failed; stopping and deleting it, waiting up to ${cleanupStopWaitSeconds(news)} s for it to stop.`,
                ).pipe(
                  Effect.andThen(
                    destroyComputeVersion(failedDeploymentId, {
                      timeoutSeconds: cleanupStopWaitSeconds(news),
                      ...(news.pollIntervalMs === undefined
                        ? {}
                        : { pollIntervalMs: news.pollIntervalMs }),
                    }),
                  ),
                  Effect.mapError(
                    (cleanupError) =>
                      new ComputeVersionNotRemoved({
                        message: versionNotRemovedMessage(
                          failedDeploymentId,
                          cleanupStopWaitSeconds(news),
                          error,
                          cleanupError,
                        ),
                        errors: [error, cleanupError],
                        cause: error,
                      }),
                  ),
                  Effect.andThen(() => Effect.fail(error)),
                )
              : Effect.fail(error);

          if (!deployment && (news.skipCodeUpload ?? false)) {
            const service = yield* getService({ serviceId }).pipe(
              Effect.map((response) => response.data),
            );
            if (service.latestDeploymentId === null) {
              return yield* new ComputeVersionInvalidProps({
                message: `skipCodeUpload copies the promoted version of Compute service '${serviceId}', but the service has no promoted version yet. Deploy a version with an artifactPath first.`,
              });
            }
          }
          if (!deployment) {
            const created = yield* createServiceDeployment({
              serviceId,
              ...(news.portMapping === undefined ? {} : { portMapping: news.portMapping }),
              ...(news.skipCodeUpload === undefined ? {} : { skipCodeUpload: news.skipCodeUpload }),
            }).pipe(
              // A replayed create would make a second deployment; the retry
              // policy cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => response.data),
            );
            createdDeploymentId = created.id;
            if (artifact !== undefined && !created.uploadUrl) {
              return yield* cleanupCreatedDeploymentOnFailure(
                created.id,
                new ComputeVersionOperationFailed({
                  message: "Prisma deployment creation did not return an upload URL.",
                }),
              );
            }
            if (created.uploadUrl && artifact !== undefined) {
              yield* uploadArtifact(
                created.uploadUrl,
                artifact,
                news.artifactContentType ?? "application/octet-stream",
              ).pipe(Effect.catch((error) => cleanupCreatedDeploymentOnFailure(created.id, error)));
            }
            deployment = yield* observeDeployment(created.id).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed({
                  id: created.id,
                  foundryVersionId: created.foundryVersionId,
                  status: "new",
                  previewDomain: null,
                  createdAt: undefined,
                }),
              ),
              Effect.catch((error) => cleanupCreatedDeploymentOnFailure(created.id, error)),
            );
          }
          if (!deployment) {
            return yield* new ComputeVersionUnexpectedResponse({
              message: "Prisma deployment could not be resolved after creation.",
            });
          }

          if (news.start ?? true) {
            const currentDeployment = deployment;
            const currentDeploymentId = currentDeployment.id;
            const waitForRunning = Effect.gen(function* () {
              yield* note(
                `Waiting up to ${news.timeoutSeconds ?? 120} s for version '${currentDeploymentId}' to run.`,
              );
              return yield* waitForComputeVersionStatus(currentDeploymentId, "running", news);
            });
            const waitForUrl = (domain: string | null) =>
              news.verifyUrl === false
                ? waitForComputeUrl(toComputeUrl(domain), news)
                : note(
                    `Waiting up to ${news.urlReadinessTimeoutSeconds ?? 60} s for ${toComputeUrl(domain) ?? "the version's URL"}${news.healthCheck === undefined ? "" : news.healthCheck.path} to answer.`,
                  ).pipe(Effect.andThen(waitForComputeUrl(toComputeUrl(domain), news)));
            deployment = yield* Effect.gen(function* () {
              if (
                currentDeployment.status !== "running" &&
                currentDeployment.status !== "provisioning"
              ) {
                const started = yield* startDeploymentIdempotent(currentDeployment.id);
                if (started) {
                  const running = yield* waitForRunning;
                  const startedRunning = { ...running, previewDomain: started.previewDomain };
                  yield* waitForUrl(startedRunning.previewDomain);
                  return startedRunning;
                }
              }
              const running = yield* waitForRunning;
              yield* waitForUrl(running.previewDomain);
              return running;
            }).pipe(
              Effect.catch((error) =>
                cleanupCreatedDeploymentOnFailure(currentDeploymentId, error),
              ),
            );
          }

          return attrsFrom(deployment, serviceId, { artifactHash, triggersHash });
        }),
        delete: Effect.fn(function* ({ output: saved, session }) {
          const output = saved && currentAttributes(saved);
          if (isPrismaDevId(output.versionId)) return;
          const deployment = yield* observeDeployment(output.versionId).pipe(
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!deployment) return;
          yield* ensureVersionMembership(output.serviceId, deployment);
          // The version the service serves is never deleted on its own: the
          // service would stop serving. Its own delete removes it. A failed
          // version serves nothing, so it is deleted.
          const served =
            deployment.status !== "failed" &&
            (yield* getService({ serviceId: output.serviceId }).pipe(
              Effect.map((response) => response.data.latestDeploymentId === output.versionId),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            ));
          if (served) {
            if (session !== undefined) {
              yield* session.note(
                `Prisma Compute version '${deployment.id}' is the version service '${output.serviceId}' serves, so it is kept; deleting the service removes it.`,
              );
            }
            return;
          }
          yield* destroyComputeVersion(output.versionId).pipe(
            // The stop was requested; it finishes once open connections close.
            Effect.catchIf(
              (error) => error instanceof PrismaComputeVersionWaitTimeout,
              (error) =>
                Effect.fail(
                  new Provider.DeleteInProgress({
                    message: `${error.message}. Prisma Compute drains open connections before it stops a deployment, and only a stopped deployment can be deleted.`,
                  }),
                ),
            ),
          );
        }),
        tail: ({ output: saved }) => {
          const { versionId } = currentAttributes(saved);
          return versionId ? tailDeploymentLogs(versionId) : Stream.empty;
        },
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(
    ComputeVersion,
    ["versionId"],
    ({ id, news }) => ({
      versionId: devId("deployment", id),
      serviceId: attrOrString(news.service, "serviceId"),
      foundryVersionId: devId("foundry-version", id),
      status: "new",
      previewDomain: undefined,
      artifactHash: undefined,
      triggersHash: undefined,
      url: undefined,
      createdAt: DEV_TIMESTAMP,
    }),
    { oldAttributes: ["deploymentId", "appId", "appEndpointDomain"] },
  );

export const ComputeVersionProvider = () =>
  ProviderLayer.dual(ComputeVersion, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
