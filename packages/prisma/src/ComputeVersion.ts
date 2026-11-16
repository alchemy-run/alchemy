import { Retry } from "@distilled.cloud/prisma";
import {
  type GetServiceDeploymentsResponse,
  getServiceDeployments,
  createServiceDeployment,
} from "@distilled.cloud/prisma/management";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  destroyComputeVersion,
  PrismaComputeVersionWaitTimeout,
  waitForComputeVersionStatus,
} from "./ComputeLifecycle.ts";
import type { ComputeService } from "./ComputeService.ts";
import {
  inspectArtifactFile,
  readArtifactFile,
  type ArtifactFile,
} from "./internal/ArtifactFile.ts";
import { executeArtifactUpload } from "./internal/ArtifactUpload.ts";
import { aggregateCleanupFailure } from "./internal/CleanupFailure.ts";
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
import { promoteVersionObserved } from "./internal/ServicePromotion.ts";
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
   */
  artifactPath?: string;
  /**
   * Content type for artifact uploads.
   *
   * @default "application/octet-stream"
   */
  artifactContentType?: string;
  /**
   * Start the version after it is created.
   *
   * @default false
   */
  start?: boolean;
  /**
   * Promote the version to the service's stable endpoint after start.
   * If `start` is omitted, enabling promotion starts the version first.
   *
   * @default false
   */
  promote?: boolean;
  /**
   * Opaque key/value map; when any resolved value changes, a replacement
   * deployment is planned (create-before-delete) even if the artifact is
   * unchanged — the same contract as `AWS.ApiGateway.Deployment.triggers`.
   * Because values here may be secrets, they are folded into the deployment
   * fingerprint as a salted hash and persisted `Redacted` rather than
   * compared as plaintext; plaintext never lands in state.
   *
   * Prisma snapshots environment variables into a deployment when the
   * deployment is created, so changing only an environment variable's value
   * updates the platform's variable record but never reaches the running app.
   * Pass those values here to make such a change take effect.
   *
   * Members may be wrapped in `Redacted.make(secret)`; they are unwrapped only
   * to compute the fingerprint.
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
   *   triggers: { DATABASE_URL: Redacted.make(databaseUrl) },
   *   start: true,
   *   promote: true,
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
     * Stable endpoint domain of the service after promotion.
     */
    serviceEndpointDomain: string | undefined;
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
 * This is the low-level resource: it can upload or reuse an artifact, start it,
 * and promote it, but it does not provide `Prisma.Compute`'s preview/stable
 * health checks or automatic rollback. Prefer `Prisma.Compute` for production
 * application deployments.
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
 * **Example:** Fork the currently promoted artifact
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-v2", {
 *   service: service.serviceId,
 *   skipCodeUpload: true,
 *   start: true,
 *   promote: true,
 * });
 * ```
 *
 * **Example:** Upload a prebuilt artifact
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-v3", {
 *   service: service.serviceId,
 *   artifactPath: "./dist/app.tar.gz",
 *   artifactContentType: "application/gzip",
 *   start: true,
 *   promote: true,
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const ComputeVersion = Resource<ComputeVersion>("Prisma.ComputeVersion", {
  aliases: ["Prisma.Deployment"],
});

/** Attributes as `Prisma.Deployment` wrote them, before the rename. */
interface LegacyComputeVersionAttributes extends Omit<
  ComputeVersion["Attributes"],
  "versionId" | "serviceId" | "serviceEndpointDomain"
> {
  deploymentId: string;
  appId: string;
  appEndpointDomain: string | undefined;
}

type SavedAttributes = ComputeVersion["Attributes"] | LegacyComputeVersionAttributes;

/** Read attributes saved before or after the rename under the current names. */
function currentAttributes(saved: SavedAttributes): ComputeVersion["Attributes"] {
  if ("versionId" in saved) return saved;
  const { deploymentId, appId, appEndpointDomain, ...rest } = saved;
  return {
    ...rest,
    versionId: deploymentId,
    serviceId: appId,
    serviceEndpointDomain: appEndpointDomain,
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
    serviceEndpointDomain?: string;
  },
): ComputeVersion["Attributes"] => ({
  versionId: deployment.id,
  serviceId,
  foundryVersionId: deployment.foundryVersionId,
  status: deployment.status,
  previewDomain: deployment.previewDomain,
  artifactHash: extra?.artifactHash,
  triggersHash: extra?.triggersHash,
  serviceEndpointDomain: extra?.serviceEndpointDomain,
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
    const resolved = path.resolve(input.artifactPath);
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
            const newArtifactHash = yield* artifactHashOf({
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
            const updateProps = {
              start: news.start,
              promote: news.promote,
            };
            if (!isResolved(updateProps)) return undefined;
            const resolvedUpdateProps = updateProps as Pick<
              ComputeVersionProps,
              "start" | "promote"
            >;
            if ((resolvedUpdateProps.start ?? false) || (resolvedUpdateProps.promote ?? false)) {
              // Reconcile asserted lifecycle state on every deploy so external
              // stops and service routing drift are repaired.
              return { action: "update" } as const;
            }
            if (
              (resolvedUpdateProps.start ?? false) !== (olds.start ?? false) ||
              (resolvedUpdateProps.promote ?? false) !== (olds.promote ?? false)
            ) {
              return { action: "update" } as const;
            }
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
        reconcile: Effect.fn(function* ({ news, output: saved }) {
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
          if ((news.promote ?? false) && news.start === false) {
            return yield* new ComputeVersionInvalidProps({
              message: "promote cannot be combined with start: false.",
            });
          }
          const artifact = yield* readUploadArtifact({
            artifactPath: news.artifactPath,
            output: "file",
          });
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
          const serviceId = yield* resolveServiceId(news.service);
          const deploymentId = isPrismaDevId(output?.versionId) ? undefined : output?.versionId;
          let deployment: ObservedDeployment | undefined = deploymentId
            ? yield* observeDeployment(deploymentId).pipe(
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          if (deployment) {
            yield* ensureVersionMembership(serviceId, deployment);
            if (deployment.status === "failed") {
              return yield* new ComputeVersionOperationFailed({
                message: `Prisma deployment '${deployment.id}' is in terminal status 'failed' and must be replaced before reconcile; refusing to restart it or change the stable versionId during an update.`,
              });
            }
          }
          let createdDeploymentId: string | undefined;
          const cleanupCreatedDeploymentOnFailure = <E>(failedDeploymentId: string, error: E) =>
            createdDeploymentId === failedDeploymentId
              ? destroyComputeVersion(failedDeploymentId).pipe(
                  Effect.mapError((cleanupError) =>
                    aggregateCleanupFailure(
                      "deployment",
                      failedDeploymentId,
                      `/v1/deployments/${failedDeploymentId}`,
                      error,
                      cleanupError,
                    ),
                  ),
                  Effect.andThen(() => Effect.fail(error)),
                )
              : Effect.fail(error);

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

          let serviceEndpointDomain = output?.serviceEndpointDomain;
          const shouldStart = news.start ?? news.promote ?? false;
          if (shouldStart) {
            const currentDeployment = deployment;
            const currentDeploymentId = currentDeployment.id;
            deployment = yield* Effect.gen(function* () {
              if (
                currentDeployment.status !== "running" &&
                currentDeployment.status !== "provisioning"
              ) {
                const started = yield* startDeploymentIdempotent(currentDeployment.id);
                if (started) {
                  return yield* waitForComputeVersionStatus(currentDeployment.id, "running").pipe(
                    Effect.map((running) => ({
                      ...running,
                      previewDomain: started.previewDomain,
                    })),
                  );
                }
              }
              return yield* waitForComputeVersionStatus(currentDeployment.id, "running");
            }).pipe(
              Effect.catch((error) =>
                cleanupCreatedDeploymentOnFailure(currentDeploymentId, error),
              ),
            );
          }
          if (news.promote ?? false) {
            // Promotion is deliberately replayed even when the control-plane
            // record already names this deployment. The endpoint operation also
            // repairs provider routing and custom-domain assignment drift.
            const promoted = yield* promoteVersionObserved(serviceId, deployment.id);
            serviceEndpointDomain = promoted.appEndpointDomain;
          }

          return attrsFrom(deployment, serviceId, {
            artifactHash,
            triggersHash,
            serviceEndpointDomain,
          });
        }),
        delete: Effect.fn(function* ({ output: saved }) {
          const output = saved && currentAttributes(saved);
          if (isPrismaDevId(output.versionId)) return;
          const deployment = yield* observeDeployment(output.versionId).pipe(
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!deployment) return;
          yield* ensureVersionMembership(output.serviceId, deployment);
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
      serviceEndpointDomain: undefined,
      createdAt: DEV_TIMESTAMP,
    }),
    { oldAttributes: ["deploymentId", "appId", "appEndpointDomain"] },
  );

export const ComputeVersionProvider = () =>
  ProviderLayer.dual(ComputeVersion, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
