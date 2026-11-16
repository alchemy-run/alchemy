import { Retry } from "@distilled.cloud/prisma";
import {
  type GetServicesResponse,
  getServices,
  getService,
  updateService,
  createService,
} from "@distilled.cloud/prisma/management";
import { Unowned, Unresolved } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { destroyComputeService, toComputeUrl } from "./ComputeLifecycle.ts";
import type { ComputeVersion } from "./ComputeVersion.ts";
import { desiredBranchId } from "./internal/Branches.ts";
import { DEV_TIMESTAMP, attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import type { ObservedApp } from "./internal/Observed.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./internal/Refs.ts";
import { updateRowSavedBeforeRename } from "./internal/RenamedState.ts";
import { ensureServiceImmutableIdentity } from "./internal/ServiceIdentity.ts";
import { checkStableEndpoint, promoteVersionObserved } from "./internal/ServicePromotion.ts";
import type { ComputeHealthCheck } from "./internal/UrlCheck.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import type { PrismaRegionId } from "./Types.ts";

export class ComputeServiceConflict extends Data.TaggedError("ComputeServiceConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeServiceInvalidProps extends Data.TaggedError("ComputeServiceInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeServiceOperationFailed extends Data.TaggedError(
  "ComputeServiceOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeServiceUnexpectedResponse extends Data.TaggedError(
  "ComputeServiceUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** More than one version is attached to a service as its active version. */
export class ComputeServiceTooManyActiveVersions extends Data.TaggedError(
  "ComputeServiceTooManyActiveVersions",
)<{
  readonly message: string;
}> {}

/**
 * The service's stable endpoint failed its check after a promotion. When the
 * service had an active version before, it was restored to it.
 */
export class ComputeServiceEndpointCheckFailed extends Data.TaggedError(
  "ComputeServiceEndpointCheckFailed",
)<{
  readonly message: string;
  readonly errors: readonly unknown[];
  readonly cause?: unknown;
}> {}

/**
 * The stable endpoint failed its check, and the service did not report the
 * earlier version as live again after the rollback. Nothing else was changed.
 */
export class ComputeServiceRollbackNotConverged extends Data.TaggedError(
  "ComputeServiceRollbackNotConverged",
)<{
  readonly message: string;
  readonly errors: readonly unknown[];
  readonly cause?: unknown;
}> {}

export interface ComputeServiceProps {
  /**
   * Project ID or `project.projectId` output that owns this service.
   */
  project: string | Project;
  /**
   * Service display name. If omitted, Alchemy generates a stable physical name.
   */
  displayName?: string;
  /**
   * Region where the service is placed.
   *
   * @default The project's default region, falling back to "us-east-1"
   */
  regionId?: PrismaRegionId;
  /**
   * Branch ID to attach the service to. Mutually exclusive with branchGitName.
   */
  branchId?: string;
  /**
   * Branch git name to attach the service to. Mutually exclusive with branchId.
   */
  branchGitName?: string;
  /**
   * Stable identity of this declaration on the Prisma platform, unique per
   * branch. A rename in the Console does not change it. After lost state, the
   * provider finds the service by it instead of creating a second one, and
   * `--adopt` (or `adopt(true)`) takes it back over, because a logical ID alone
   * does not prove which stack owns it. Changing it updates the service in place.
   * @default the resource's fully qualified logical ID, e.g. `"web"` or `"Site/Web"`
   */
  logicalId?: string;
  /**
   * After promoting the active version, wait until the service's stable URL
   * answers on Prisma's edge. When it does not, the service is rolled back to
   * the version that was active before and the deploy fails. Has no effect
   * when no version is attached with `Prisma.activateVersion`.
   *
   * @default true
   */
  verifyUrl?: boolean;
  /**
   * Application path probed on the stable URL after a promotion. Cannot be
   * combined with `verifyUrl: false`.
   *
   * @example
   * ```typescript
   * healthCheck: { path: "/api/health", statusCodes: [200] }
   * ```
   */
  healthCheck?: ComputeHealthCheck;
  /**
   * Maximum seconds to wait for the stable URL to answer after a promotion.
   *
   * @default 60
   */
  urlReadinessTimeoutSeconds?: number;
  /**
   * Maximum seconds to wait for the service to report the promoted version,
   * or the restored version after a rollback, as live.
   *
   * @default 60
   */
  timeoutSeconds?: number;
  /**
   * Milliseconds between observations of the service and probes of its URL.
   *
   * @default 1000
   */
  pollIntervalMs?: number;
}

/** What `Prisma.activateVersion` attaches to a service. */
export interface ComputeServiceActiveVersion {
  /** The version the service promotes. */
  versionId: string;
}

export interface ComputeService extends Resource<
  "Prisma.ComputeService",
  ComputeServiceProps,
  {
    /**
     * Prisma Compute service ID, `cps_…`.
     */
    serviceId: string;
    /**
     * Service display name.
     */
    name: string;
    /**
     * Project ID that owns the service.
     */
    projectId: string;
    /**
     * Region ID where the service is placed.
     */
    regionId: string;
    /**
     * Branch ID attached to the service, or null when unassigned.
     */
    branchId: string | null;
    /**
     * ID of the version the service serves on its stable endpoint, as the
     * platform reports it, or null before any version was promoted.
     */
    activeVersionId: string | null;
    /**
     * Stable endpoint domain of the service.
     */
    serviceEndpointDomain: string;
    /**
     * HTTPS URL of the service's stable endpoint.
     */
    url: string;
    /**
     * ISO timestamp when the service was created.
     */
    createdAt: string;
    /**
     * Logical ID recorded on the service, or null when none is set.
     */
    logicalId: string | null;
  },
  ComputeServiceActiveVersion,
  Providers,
  ComputeServiceLookup
> {}

/**
 * Props for {@link ComputeService.lookup}: find a service this stack
 * doesn't manage by its id.
 */
export interface ComputeServiceLookup {
  /** Prisma Compute service id, `cps_…`. */
  serviceId: string;
}

/**
 * A Prisma Compute service, the long-lived application that owns its versions
 * and the stable endpoint.
 *
 * Omit `branchId` and `branchGitName` to attach the service to the project's
 * current default branch. Service regions are immutable; create a second
 * service and cut traffic over when moving regions. Use `Prisma.Compute` for
 * the usual build, deploy, health-check, and promotion workflow; use
 * `ComputeService` directly when managing standalone `Prisma.ComputeVersion`
 * resources.
 *
 * This resource was named `Prisma.App`. State saved under that type is still
 * read, and is rewritten under the new type on the next deploy.
 *
 * ### Creating a Service
 * **Example:** Service on the default branch
 * ```typescript
 * const service = yield* Prisma.ComputeService("web", {
 *   project,
 * });
 * ```
 *
 * **Example:** Service on a preview branch
 * ```typescript
 * const service = yield* Prisma.ComputeService("preview-web", {
 *   project,
 *   branchId: preview.branchId,
 * });
 * ```
 *
 * ### Serving a Version
 * A service serves one version on its stable endpoint, its active version.
 * Attach it with `Prisma.activateVersion`. On every deploy the service
 * promotes the attached version, waits until the platform reports it as live,
 * and checks the stable URL. When the check fails, the service is rolled back
 * to the version that was active before and the deploy fails. A service with
 * no attached version keeps serving whatever it serves. The service never
 * stops or deletes a version.
 *
 * **Example:** Serve a new artifact on the stable endpoint
 * ```typescript
 * const service = yield* Prisma.ComputeService("web", {
 *   project,
 *   healthCheck: { path: "/api/health" },
 * });
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   service: service.serviceId,
 *   artifactPath: "./dist/app.tar.gz",
 *   start: true,
 * });
 * yield* Prisma.activateVersion(service, version);
 * ```
 *
 * ### Looking up an existing Service
 * `ComputeService.lookup` references a service Alchemy doesn't manage (created
 * in the Prisma Console or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing service
 * ```typescript
 * const api = Prisma.ComputeService.lookup({ serviceId: "cps_cmabc123def456ghi789jkl0" });
 * ```
 *
 * @resource
 * @product Compute
 */
export const ComputeService = Resource<ComputeService>("Prisma.ComputeService", {
  aliases: ["Prisma.App"],
});

/** Attributes as `Prisma.App` wrote them, before the rename. */
interface LegacyComputeServiceAttributes extends Omit<
  ComputeService["Attributes"],
  "serviceId" | "activeVersionId" | "serviceEndpointDomain" | "url"
> {
  appId: string;
  latestDeploymentId: string | null;
  appEndpointDomain: string;
}

type SavedAttributes = ComputeService["Attributes"] | LegacyComputeServiceAttributes;

/** Read attributes saved before or after the rename under the current names. */
function currentAttributes(saved: SavedAttributes): ComputeService["Attributes"] {
  if ("serviceId" in saved) return saved;
  const { appId, latestDeploymentId, appEndpointDomain, ...rest } = saved;
  return {
    ...rest,
    serviceId: appId,
    activeVersionId: latestDeploymentId,
    serviceEndpointDomain: appEndpointDomain,
    url: toComputeUrl(appEndpointDomain) ?? appEndpointDomain,
  };
}

const isLegacyAttributes = (saved: SavedAttributes | undefined) =>
  saved !== undefined && !("serviceId" in saved);

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listApps = (filter: { projectId?: string; logicalId?: string; branchId?: string } = {}) =>
  Effect.gen(function* () {
    const apps: GetServicesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getServices({
        limit: 100,
        ...filter,
        ...(cursor === undefined ? {} : { cursor }),
      });
      apps.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getServices: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return apps;
  });

const createDisplayName = (id: string, displayName: string | undefined) =>
  displayName === undefined ? createPhysicalName({ id }) : Effect.succeed(displayName);

const findApp = Effect.fn(function* (
  projectId: string,
  displayName: string,
  props: Pick<ComputeServiceProps, "branchId" | "branchGitName">,
) {
  const candidates = (yield* listApps({ projectId })).filter((app) => app.name === displayName);
  if (candidates.length === 0) return undefined;
  const branch = yield* desiredBranchId(projectId, props);
  if (!branch.resolved) return undefined;
  const matches = candidates.filter((app) => app.branchId === branch.id);
  if (matches.length > 1) {
    return yield* new ComputeServiceConflict({
      message: `Prisma returned multiple Compute services named '${displayName}' on branch '${branch.id}' in project '${projectId}'; refusing an ambiguous ownership match.`,
    });
  }
  return matches[0];
});

const findAppByLogicalId = Effect.fn(function* (
  projectId: string,
  logicalId: string,
  props: Pick<ComputeServiceProps, "branchId" | "branchGitName">,
) {
  const branch = yield* desiredBranchId(projectId, props);
  if (!branch.resolved) return undefined;
  const apps = yield* listApps({ projectId, logicalId, branchId: branch.id });
  return apps.find((app) => app.logicalId === logicalId && app.branchId === branch.id);
});

export class PrismaComputeServiceLogicalIdTaken extends Data.TaggedError(
  "PrismaComputeServiceLogicalIdTaken",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const logicalIdTaken = (logicalId: string, branchId: string, projectId: string, cause: unknown) =>
  new PrismaComputeServiceLogicalIdTaken({
    message: `Prisma Compute service logical ID '${logicalId}' is already used by another service on branch '${branchId}' in project '${projectId}'. Logical IDs are unique per branch; choose a different logicalId or remove it from the other service.`,
    cause,
  });

const attrsFrom = (app: ObservedApp): ComputeService["Attributes"] => ({
  serviceId: app.id,
  name: app.name,
  projectId: app.projectId,
  regionId: app.region.id,
  branchId: app.branchId,
  activeVersionId: app.latestDeploymentId,
  serviceEndpointDomain: app.appEndpointDomain,
  url: toComputeUrl(app.appEndpointDomain) ?? app.appEndpointDomain,
  createdAt: app.createdAt,
  logicalId: app.logicalId ?? null,
});

const branchNeedsSync = Effect.fn(function* (
  projectId: string,
  app: ObservedApp,
  props: ComputeServiceProps,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return app.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    const branch = yield* desiredBranchId(projectId, props);
    return !branch.resolved || app.branchId !== branch.id;
  }
  const branch = yield* desiredBranchId(projectId, props);
  return !branch.resolved || branch.id !== app.branchId;
});

const validateAppProps = (props: ComputeServiceProps) =>
  Effect.gen(function* () {
    if (props.healthCheck !== undefined && props.verifyUrl === false) {
      return yield* new ComputeServiceInvalidProps({
        message: "healthCheck cannot be combined with verifyUrl: false.",
      });
    }
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* new ComputeServiceInvalidProps({
        message: "branchId and branchGitName are mutually exclusive.",
      });
    }
    if (props.branchId === null || props.branchGitName === null) {
      return yield* new ComputeServiceInvalidProps({
        message:
          "Prisma.ComputeService requires an attached branch because the Management API cannot create an unassigned service atomically. Omit both fields to use the project default branch, or provide branchId/branchGitName.",
      });
    }
  });

/**
 * Observe the service, create it when it is missing, and converge its name,
 * branch and logical ID. `admitted` is a service `observe` already admitted
 * for a precreate, which finds no saved ID.
 */
const ensureService = Effect.fn(function* ({
  id,
  fqn,
  news,
  output,
  admitted,
}: {
  id: string;
  fqn: string;
  news: ComputeServiceProps;
  output: ComputeService["Attributes"] | undefined;
  admitted?: ObservedApp;
}) {
  yield* validateAppProps(news);
  const projectId = yield* resolveProjectId(news.project);
  const displayName = yield* createDisplayName(id, news.displayName);
  const logicalId = news.logicalId ?? fqn;
  const branch = yield* desiredBranchId(projectId, news);
  if (!branch.resolved) {
    return yield* new ComputeServiceOperationFailed({
      message:
        news.branchGitName === undefined
          ? `Prisma project '${projectId}' has no default branch to attach service '${displayName}'. Create or promote a default branch, or specify branchId/branchGitName.`
          : `Prisma project '${projectId}' has no branch named '${news.branchGitName}' to attach service '${displayName}'.`,
    });
  }
  const serviceId = isPrismaDevId(output?.serviceId) ? undefined : output?.serviceId;
  let app: ObservedApp | undefined = serviceId
    ? yield* getService({ serviceId }).pipe(
        Effect.map((response) => response.data),
        Effect.catchTag("NotFound", () => Effect.undefined),
      )
    : admitted;
  if (!app) {
    const result = yield* createService({
      projectId,
      displayName,
      branchId: branch.id,
      ...(news.regionId === undefined ? {} : { regionId: news.regionId }),
      logicalId,
    }).pipe(
      // A replayed create would make a second service; the retry policy
      // cannot see the request, so opt out explicitly.
      Retry.none,
      Effect.map((response) => ({
        app: response.data,
        created: true,
      })),
      Effect.catchTag("Conflict", (conflict) =>
        Effect.gen(function* () {
          if ((yield* findAppByLogicalId(projectId, logicalId, news)) !== undefined) {
            return yield* logicalIdTaken(logicalId, branch.id, projectId, conflict);
          }
          const app = yield* findApp(projectId, displayName, news);
          if (app && output?.serviceId !== undefined && app.id === output.serviceId) {
            return { app, created: false };
          }
          return yield* new ComputeServiceConflict({
            message: `Prisma Compute service '${displayName}' already exists on the requested branch but is not owned by this resource. Import it with explicit adoption or choose a different display name.`,
            cause: conflict,
          });
        }),
      ),
    );
    app = result.app;
  }
  yield* ensureServiceImmutableIdentity(
    app,
    projectId,
    news.regionId ?? output?.regionId ?? app.region.id,
  );
  const needsBranchSync = yield* branchNeedsSync(projectId, app, news);
  if (app.name !== displayName || needsBranchSync) {
    app = yield* updateService({
      serviceId: app.id,
      displayName,
      branchId: branch.id,
    }).pipe(Effect.map((response) => response.data));
  }
  if (app.logicalId !== logicalId) {
    // The API refuses to rebind a logical ID; it must be cleared first.
    if (app.logicalId) {
      app = yield* updateService({ serviceId: app.id, logicalId: null }).pipe(
        Effect.map((response) => response.data),
      );
    }
    // The API refuses logicalId in the same request as a branch
    // move, so it is set only after the move above.
    app = yield* updateService({ serviceId: app.id, logicalId }).pipe(
      Effect.map((response) => response.data),
      Effect.catchTag("Conflict", (conflict) =>
        Effect.fail(logicalIdTaken(logicalId, branch.id, projectId, conflict)),
      ),
    );
  }
  if (app.name !== displayName || app.branchId !== branch.id) {
    return yield* new ComputeServiceUnexpectedResponse({
      message: `Prisma Compute service '${app.id}' did not converge to display name '${displayName}' and branch '${branch.id ?? "null"}'. Refusing to persist mismatched service state.`,
    });
  }
  return app;
});

const ACTIVE_VERSION_SID_PREFIX = "Prisma.ComputeService.ActiveVersion(";

/**
 * Attach a version to its service as the service's active version. On every
 * deploy the service promotes it and checks its stable endpoint. Attach at
 * most one version to a service; a second one fails the plan.
 *
 * @example
 * ```typescript
 * const service = yield* Prisma.ComputeService("web", { project });
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   service: service.serviceId,
 *   artifactPath: "./dist/app.tar.gz",
 *   start: true,
 * });
 * yield* Prisma.activateVersion(service, version);
 * ```
 */
export const activateVersion = (service: ComputeService, version: ComputeVersion) =>
  service.bind`${ACTIVE_VERSION_SID_PREFIX}${version})`({ versionId: version.versionId });

/** The sids of the bindings that attach a version as the active version. */
const activeVersionSids = (bindings: unknown): string[] =>
  Array.isArray(bindings)
    ? bindings.flatMap((binding: unknown) =>
        typeof binding === "object" &&
        binding !== null &&
        "sid" in binding &&
        typeof binding.sid === "string" &&
        binding.sid.startsWith(ACTIVE_VERSION_SID_PREFIX)
          ? [binding.sid]
          : [],
      )
    : [];

const refuseSecondActiveVersion = (id: string, bindings: unknown) => {
  const sids = activeVersionSids(bindings);
  return sids.length > 1
    ? Effect.fail(
        new ComputeServiceTooManyActiveVersions({
          message: `Prisma.ComputeService '${id}' has ${sids.length} versions attached as its active version (${sids.join(", ")}). A service serves exactly one version; attach only one with Prisma.activateVersion.`,
        }),
      )
    : Effect.void;
};

/** The version attached as the active version, once bindings resolve. */
const activeVersionOf = (bindings: ReadonlyArray<ResourceBinding<ComputeServiceActiveVersion>>) =>
  bindings.find((binding) => binding.sid.startsWith(ACTIVE_VERSION_SID_PREFIX))?.data.versionId;

/**
 * Promote the attached version, wait until the service reports it as live,
 * and check the stable endpoint. When the check fails, roll the service back
 * to the version that was active before and fail.
 */
const serveActiveVersion = Effect.fn(function* (
  app: ObservedApp,
  versionId: string,
  previousVersionId: string | null | undefined,
  news: ComputeServiceProps,
) {
  // Promotion is replayed on every deploy, also when the service already
  // serves this version: it repairs routing and custom-domain drift.
  const promoted = yield* promoteVersionObserved(app.id, versionId, news);
  const served: ObservedApp = {
    ...app,
    latestDeploymentId: versionId,
    appEndpointDomain: promoted.appEndpointDomain,
  };
  if (news.verifyUrl === false) return served;
  const rollbackVersionId =
    previousVersionId === null || previousVersionId === versionId ? undefined : previousVersionId;
  const check = yield* checkStableEndpoint(
    app.id,
    toComputeUrl(promoted.appEndpointDomain),
    rollbackVersionId,
    news,
  );
  if (check._tag === "Ready") return served;
  if (check._tag === "NoRollbackTarget") {
    return yield* new ComputeServiceEndpointCheckFailed({
      message: `Prisma Compute service '${app.id}' promoted version '${versionId}', but its stable endpoint failed its check. The service had no earlier active version to restore, so it still serves '${versionId}'.`,
      errors: [check.readinessFailure],
      cause: check.readinessFailure,
    });
  }
  if (check._tag === "RolledBack") {
    return yield* new ComputeServiceEndpointCheckFailed({
      message: `Prisma Compute service '${app.id}' promoted version '${versionId}', but its stable endpoint failed its check. The service was rolled back to version '${rollbackVersionId}'.`,
      errors:
        check.rollbackFailure === undefined
          ? [check.readinessFailure]
          : [check.readinessFailure, check.rollbackFailure],
      cause: check.readinessFailure,
    });
  }
  return yield* new ComputeServiceRollbackNotConverged({
    message: `Prisma Compute service '${app.id}' promoted version '${versionId}', but its stable endpoint failed its check, and after a rollback to version '${rollbackVersionId}' the service never reported that version as live. Nothing else was changed; check the service in the Prisma Console.`,
    errors: [
      check.readinessFailure,
      ...(check.rollbackFailure === undefined ? [] : [check.rollbackFailure]),
      check.observationFailure,
    ],
    cause: check.readinessFailure,
  });
});

/**
 * Find a service in its project the way `read` does: by logical ID, and for a
 * derived logical ID also by the generated display name. `provenOwned` is set
 * when the match is this resource's own interrupted create.
 */
const findServiceInProject = Effect.fn(function* (
  id: string,
  fqn: string,
  props: ComputeServiceProps,
) {
  const projectId = unresolvedProjectIdOf(props.project);
  if (!projectId) return undefined;
  const byLogicalId = yield* findAppByLogicalId(projectId, props.logicalId ?? fqn, props);
  if (byLogicalId) {
    // A logical ID alone does not prove ownership: another
    // declaration, stage, or stack on the branch can hold it.
    // The generated display name embeds this instance's ID,
    // so a match on it is this resource's interrupted create.
    const provenOwned =
      props.displayName === undefined &&
      byLogicalId.name === (yield* createDisplayName(id, undefined));
    return { app: byLogicalId, provenOwned };
  }
  // An explicit logical ID is the only identity. A derived one
  // falls back to the display name for services created before
  // logical IDs existed.
  if (props.logicalId !== undefined) return undefined;
  const byName = yield* findApp(projectId, yield* createDisplayName(id, props.displayName), props);
  return byName ? { app: byName, provenOwned: false } : undefined;
});

const ProviderLive = () =>
  Provider.effect(
    ComputeService,
    Effect.gen(function* () {
      return {
        stables: ["serviceId"],
        list: () => listApps().pipe(Effect.map((apps) => apps.map(attrsFrom))),
        diff: Effect.fn(
          function* ({ id, fqn, olds, news, output: saved }) {
            if (!isInputObject(news)) return undefined;
            const output = saved && currentAttributes(saved);
            if (isPrismaDevId(output?.serviceId)) {
              return { action: "update" } as const;
            }
            const oldProjectId = output?.projectId ?? unresolvedProjectIdOf(olds.project);
            const newProjectId = isResolved(news.project)
              ? unresolvedProjectIdOf(news.project)
              : undefined;
            if (concreteIdsChanged(oldProjectId, newProjectId)) {
              return { action: "replace" } as const;
            }
            if (isResolved(news.regionId) && news.regionId !== undefined) {
              const currentRegionId = output?.regionId ?? olds.regionId;
              if (currentRegionId !== undefined && news.regionId !== currentRegionId) {
                return yield* new ComputeServiceInvalidProps({
                  message: `Prisma Compute service region is immutable and the Management API cannot atomically move a service without deleting its serving endpoint first. Create a second service with a different display name in the target region, cut traffic over, then remove this service.`,
                });
              }
            }
            if (
              isResolved(news.logicalId) &&
              (news.logicalId ?? fqn) !== (output ? output.logicalId : (olds.logicalId ?? fqn))
            ) {
              return { action: "update" } as const;
            }
            const updateProps = {
              displayName: news.displayName,
              branchId: news.branchId,
              branchGitName: news.branchGitName,
            };
            if (!isResolved(updateProps)) return undefined;
            const resolvedUpdateProps = {
              ...(updateProps as Pick<
                ComputeServiceProps,
                "displayName" | "branchId" | "branchGitName"
              >),
              displayName: yield* createDisplayName(
                id,
                (updateProps as Pick<ComputeServiceProps, "displayName">).displayName,
              ),
            };
            if (!output) {
              return deepEqual(resolvedUpdateProps, {
                displayName: yield* createDisplayName(id, olds.displayName),
                branchId: olds.branchId,
                branchGitName: olds.branchGitName,
              })
                ? undefined
                : ({ action: "update" } as const);
            }
            if (output.name !== resolvedUpdateProps.displayName) {
              return { action: "update" } as const;
            }
            const branch = yield* desiredBranchId(
              newProjectId ?? output.projectId,
              resolvedUpdateProps,
            );
            return !branch.resolved || output.branchId !== branch.id
              ? ({ action: "update" } as const)
              : undefined;
          },
          (effect, { id, output: saved, newBindings }) =>
            Effect.gen(function* () {
              yield* refuseSecondActiveVersion(id, newBindings);
              const diff = yield* effect;
              // The service promotes its attached version on every deploy. Its
              // ID and URL survive that; `activeVersionId` must be re-read, or a
              // resource reading it keeps the old version.
              const planned =
                activeVersionSids(newBindings).length === 0 || diff?.action === "replace"
                  ? diff
                  : { action: "update" as const, stables: ["serviceId", "url"] };
              return updateRowSavedBeforeRename(isLegacyAttributes(saved), planned);
            }),
        ),
        lookup: Effect.fn(function* ({ serviceId }) {
          const app = yield* getService({ serviceId }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          return app ? attrsFrom(app) : undefined;
        }),

        read: Effect.fn(function* ({ id, fqn, output: saved, olds }) {
          const output = saved && currentAttributes(saved);
          const serviceId = isPrismaDevId(output?.serviceId) ? undefined : output?.serviceId;
          const found = serviceId
            ? yield* getService({ serviceId }).pipe(
                Effect.map((response) => ({ app: response.data, provenOwned: false })),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : yield* findServiceInProject(id, fqn, olds);
          const app = found?.app;
          const provenOwned = found?.provenOwned ?? false;
          if (!app) return undefined;
          const attrs = attrsFrom(app);
          return serviceId || provenOwned ? attrs : Unowned(attrs);
        }),
        observe: Effect.fn(function* ({ id, fqn, news }) {
          if (!isResolved(news)) return Unresolved;
          const found = yield* findServiceInProject(id, fqn, news);
          if (!found) return undefined;
          const attrs = attrsFrom(found.app);
          return found.provenOwned ? attrs : Unowned(attrs);
        }),
        // A service and its active version need each other's IDs. The engine
        // breaks that cycle here: the service is created first, with no
        // active version, and `reconcile` promotes the version later.
        precreate: Effect.fn(function* ({ id, fqn, news, bindings }) {
          yield* refuseSecondActiveVersion(id, bindings);
          if (!isResolved(news)) {
            return yield* new ComputeServiceInvalidProps({
              message: `Prisma.ComputeService '${id}' takes a prop from a resource that depends on the service, so the service cannot be created first. Pass a project, branch and names that do not depend on the service's own versions.`,
            });
          }
          const found = yield* findServiceInProject(id, fqn, news);
          const app = yield* ensureService({
            id,
            fqn,
            news,
            output: undefined,
            admitted: found?.app,
          });
          return attrsFrom(app);
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news, output: saved, bindings }) {
          const output = saved && currentAttributes(saved);
          yield* refuseSecondActiveVersion(id, bindings);
          const app = yield* ensureService({ id, fqn, news, output });
          const versionId = activeVersionOf(bindings);
          return attrsFrom(
            versionId === undefined
              ? app
              : yield* serveActiveVersion(app, versionId, output?.activeVersionId, news),
          );
        }),
        delete: Effect.fn(function* ({ output: saved }) {
          const output = saved && currentAttributes(saved);
          if (isPrismaDevId(output.serviceId)) return;
          const app = yield* getService({ serviceId: output.serviceId }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!app) return;
          if (app.projectId !== output.projectId || app.region.id !== output.regionId) {
            return yield* new ComputeServiceConflict({
              message: `Prisma Compute service '${app.id}' no longer matches its persisted immutable project and region identity. Refusing to delete a mismatched service.`,
            });
          }
          yield* destroyComputeService(output.serviceId);
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(
    ComputeService,
    ["serviceId"],
    ({ id, fqn, news, bindings }) => ({
      serviceId: devId("app", id),
      name: news.displayName ?? id,
      projectId: attrOrString(news.project, "projectId"),
      regionId: news.regionId ?? "us-east-1",
      branchId: news.branchId ?? null,
      activeVersionId:
        attrOrString(
          bindings.find((binding) => binding.sid.startsWith(ACTIVE_VERSION_SID_PREFIX))?.data,
          "versionId",
        ) ?? null,
      serviceEndpointDomain: "localhost",
      url: "http://localhost",
      createdAt: DEV_TIMESTAMP,
      logicalId: news.logicalId ?? fqn,
    }),
    { oldAttributes: ["appId", "latestDeploymentId", "appEndpointDomain"] },
    { precreate: true },
  );

export const ComputeServiceProvider = () =>
  ProviderLayer.dual(ComputeService, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
