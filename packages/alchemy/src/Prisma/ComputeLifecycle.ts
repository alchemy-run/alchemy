import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  isConflict,
  isNotFound,
  PrismaApiError,
  type PrismaManagementClient,
} from "./Client.ts";
import type { ComputeVersion } from "./Types.ts";
export { isConflict } from "./Client.ts";

export interface WaitForComputeVersionStatusOptions {
  /**
   * Maximum time to wait for a Compute version to reach the requested status.
   */
  timeoutSeconds?: number;
  /**
   * Poll interval used while waiting for Prisma Compute status changes.
   */
  pollIntervalMs?: number;
}

/**
 * Result returned after attempting to stop and delete a Prisma Compute version.
 */
export interface DestroyComputeVersionResult {
  /**
   * Prisma Compute version ID that was targeted.
   */
  versionId: string;
  /**
   * Status observed before cleanup started, or undefined if the version was gone.
   */
  previousStatus: string | undefined;
  /**
   * True when Alchemy requested a stop before deletion.
   */
  stopped: boolean;
  /**
   * True when the delete call completed or the version vanished during cleanup.
   */
  deleted: boolean;
}

/**
 * Result returned after deleting the versions under a Prisma Compute service.
 */
export interface DestroyComputeServiceResult {
  /**
   * Prisma Compute service ID that was targeted.
   */
  computeServiceId: string;
  /**
   * Compute version IDs deleted by this cleanup pass.
   */
  deletedVersionIds: string[];
  /**
   * True when the Compute service delete call completed or the service vanished.
   */
  serviceDeleted: boolean;
}

/**
 * Result returned after deleting Compute services under a Prisma project.
 */
export interface DestroyComputeProjectResult {
  /**
   * Prisma project ID that was targeted.
   */
  projectId: string;
  /**
   * Compute service IDs deleted by this cleanup pass.
   */
  deletedServiceIds: string[];
  /**
   * Compute version IDs deleted by this cleanup pass.
   */
  deletedVersionIds: string[];
  /**
   * True when the project delete call completed or the project vanished.
   */
  projectDeleted: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const getComputeVersion = (client: PrismaManagementClient, versionId: string) =>
  client
    .getComputeServiceVersion(versionId)
    .pipe(
      Effect.catch((primaryError) =>
        typeof client.getComputeVersion === "function"
          ? client
              .getComputeVersion(versionId)
              .pipe(
                Effect.catch((fallbackError) =>
                  isNotFound(primaryError)
                    ? Effect.fail(fallbackError)
                    : Effect.fail(primaryError),
                ),
              )
          : Effect.fail(primaryError),
      ),
    );

const stopComputeVersion = (
  client: PrismaManagementClient,
  versionId: string,
) =>
  client.stopComputeServiceVersion(versionId).pipe(
    Effect.catchIf(isConflict, () => Effect.void),
    Effect.catch((primaryError) =>
      typeof client.stopComputeVersion === "function"
        ? client.stopComputeVersion(versionId).pipe(
            Effect.catchIf(isConflict, () => Effect.void),
            Effect.catch((fallbackError) =>
              isNotFound(primaryError)
                ? Effect.fail(fallbackError)
                : Effect.fail(primaryError),
            ),
          )
        : Effect.fail(primaryError),
    ),
  );

const computeVersionDeleteFailed = (
  versionId: string,
  statusAtDelete: string | undefined,
  error: unknown,
  primaryError?: unknown,
) => {
  const format = (error: unknown) =>
    error instanceof PrismaApiError
      ? `Prisma API returned HTTP ${error.status}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  const detail =
    primaryError === undefined
      ? format(error)
      : [
          `Service-scoped delete failed: ${format(primaryError)}.`,
          `Global delete fallback failed: ${format(error)}.`,
        ].join(" ");
  const isKnownStoppedDeleteFailure =
    statusAtDelete === "stopped" &&
    error instanceof PrismaApiError &&
    error.status >= 500 &&
    (primaryError === undefined ||
      (primaryError instanceof PrismaApiError && primaryError.status >= 500));
  return new Error(
    [
      `Failed to delete Prisma compute version '${versionId}' while it was in status '${statusAtDelete ?? "unknown"}'.`,
      detail,
      isKnownStoppedDeleteFailure
        ? "Stopped Prisma Compute versions are expected to be deletable; this matches the known platform-side delete failure observed during live smoke testing."
        : undefined,
      "The version may need platform cleanup before the compute service or project can be deleted.",
      `Manual check: GET /v1/versions/${versionId}; manual retries: DELETE /v1/compute-services/versions/${versionId}, then DELETE /v1/versions/${versionId}.`,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" "),
    { cause: error },
  );
};

export const waitForComputeVersionStatus = Effect.fn(function* (
  client: PrismaManagementClient,
  versionId: string,
  targetStatus: "running" | "stopped",
  options: WaitForComputeVersionStatusOptions = {},
) {
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = yield* Effect.sync(() => Date.now());

  while (true) {
    const version = yield* getComputeVersion(client, versionId);
    if (version.status === targetStatus) {
      return version as ComputeVersion;
    }
    if (version.status === "failed") {
      return yield* Effect.fail(
        new Error(`Prisma compute version '${versionId}' failed`),
      );
    }

    const elapsed = yield* Effect.sync(() => Date.now() - startedAt);
    if (elapsed >= timeoutMs) {
      return yield* Effect.fail(
        new Error(
          `Timed out waiting for Prisma compute version '${versionId}' to reach '${targetStatus}' (last status: '${version.status}')`,
        ),
      );
    }

    yield* Effect.sleep(Duration.millis(intervalMs));
  }
});

/**
 * Stops a running or provisioning Compute version, then deletes it.
 *
 * Deletion first uses the service-scoped public route, then falls back to the
 * global version route. If both routes fail, the error message includes the
 * observed version status and manual retry routes for cleanup.
 */
export const destroyComputeVersion: (
  client: PrismaManagementClient,
  versionId: string,
  options?: WaitForComputeVersionStatusOptions,
) => Effect.Effect<DestroyComputeVersionResult, Error, never> = Effect.fn(
  function* (
    client: PrismaManagementClient,
    versionId: string,
    options: WaitForComputeVersionStatusOptions = {},
  ) {
    const version = yield* getComputeVersion(client, versionId).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
    );
    if (!version) {
      return {
        versionId,
        previousStatus: undefined,
        stopped: false,
        deleted: false,
      } satisfies DestroyComputeVersionResult;
    }

    const previousStatus = version.status;
    let statusAtDelete = previousStatus;
    let stopped = false;
    if (version.status === "running" || version.status === "provisioning") {
      yield* stopComputeVersion(client, versionId).pipe(
        Effect.catchIf(
          (e) => isNotFound(e),
          () => Effect.void,
        ),
      );
      const stoppedVersion = yield* waitForComputeVersionStatus(
        client,
        versionId,
        "stopped",
        options,
      ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
      statusAtDelete = stoppedVersion?.status ?? "stopped";
      stopped = true;
    }

    yield* client.deleteComputeServiceVersion(versionId).pipe(
      Effect.catch((primaryError) =>
        client.deleteComputeVersion(versionId).pipe(
          Effect.catchIf(isNotFound, () => Effect.void),
          Effect.catch((fallbackError) =>
            Effect.fail(
              computeVersionDeleteFailed(
                versionId,
                statusAtDelete,
                fallbackError,
                primaryError,
              ),
            ),
          ),
        ),
      ),
    );

    return {
      versionId,
      previousStatus,
      stopped,
      deleted: true,
    } satisfies DestroyComputeVersionResult;
  },
);

/**
 * Deletes every Compute version under a service, then deletes the service.
 */
export const destroyComputeService: (
  client: PrismaManagementClient,
  computeServiceId: string,
  options?: WaitForComputeVersionStatusOptions & { keepService?: boolean },
) => Effect.Effect<DestroyComputeServiceResult, Error, never> = Effect.fn(
  function* (
    client: PrismaManagementClient,
    computeServiceId: string,
    options: WaitForComputeVersionStatusOptions & {
      keepService?: boolean;
    } = {},
  ) {
    const versions = yield* client
      .listServiceComputeVersions(computeServiceId, {
        limit: 100,
      })
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
    if (!versions) {
      return {
        computeServiceId,
        deletedVersionIds: [],
        serviceDeleted: false,
      } satisfies DestroyComputeServiceResult;
    }
    const deletedVersionIds: string[] = [];
    for (const version of versions) {
      const result = yield* destroyComputeVersion(client, version.id, options);
      if (result.deleted) deletedVersionIds.push(version.id);
    }

    let serviceDeleted = false;
    if (!options.keepService) {
      yield* client
        .deleteComputeService(computeServiceId)
        .pipe(Effect.catchIf(isNotFound, () => Effect.void));
      serviceDeleted = true;
    }

    return {
      computeServiceId,
      deletedVersionIds,
      serviceDeleted,
    } satisfies DestroyComputeServiceResult;
  },
);

/**
 * Deletes every Compute service under a project, then deletes the project.
 *
 * Useful for cleanup-only live smoke retries because callers can start from the
 * project ID and let Alchemy discover the service and version IDs.
 */
export const destroyComputeProject: (
  client: PrismaManagementClient,
  projectId: string,
  options?: WaitForComputeVersionStatusOptions & { keepProject?: boolean },
) => Effect.Effect<DestroyComputeProjectResult, Error, never> = Effect.fn(
  function* (
    client: PrismaManagementClient,
    projectId: string,
    options: WaitForComputeVersionStatusOptions & {
      keepProject?: boolean;
    } = {},
  ) {
    const services = yield* client
      .listProjectComputeServices(projectId, {
        limit: 100,
      })
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
    if (!services) {
      return {
        projectId,
        deletedServiceIds: [],
        deletedVersionIds: [],
        projectDeleted: false,
      } satisfies DestroyComputeProjectResult;
    }

    const deletedServiceIds: string[] = [];
    const deletedVersionIds: string[] = [];
    for (const service of services) {
      const result = yield* destroyComputeService(client, service.id, options);
      deletedVersionIds.push(...result.deletedVersionIds);
      if (result.serviceDeleted) deletedServiceIds.push(service.id);
    }

    let projectDeleted = false;
    if (!options.keepProject) {
      yield* client
        .deleteProject(projectId)
        .pipe(Effect.catchIf(isNotFound, () => Effect.void));
      projectDeleted = true;
    }

    return {
      projectId,
      deletedServiceIds,
      deletedVersionIds,
      projectDeleted,
    } satisfies DestroyComputeProjectResult;
  },
);

export const toDeploymentUrl = (domain: string | null | undefined) =>
  domain
    ? domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`
    : undefined;
