import { Retry } from "@distilled.cloud/prisma";
import {
  type GetServicesResponse,
  getServices,
  getService,
  updateService,
  createService,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { destroyComputeService } from "./ComputeLifecycle.ts";
import { ensureAppImmutableIdentity } from "./internal/AppIdentity.ts";
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
     * ID of the version the service last promoted, when available.
     */
    latestVersionId: string | null;
    /**
     * Stable endpoint domain of the service.
     */
    serviceEndpointDomain: string;
    /**
     * ISO timestamp when the service was created.
     */
    createdAt: string;
    /**
     * Logical ID recorded on the service, or null when none is set.
     */
    logicalId: string | null;
  },
  never,
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
  "serviceId" | "latestVersionId" | "serviceEndpointDomain"
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
    latestVersionId: latestDeploymentId,
    serviceEndpointDomain: appEndpointDomain,
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
  latestVersionId: app.latestDeploymentId,
  serviceEndpointDomain: app.appEndpointDomain,
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
          (effect, { output: saved }) =>
            effect.pipe(
              Effect.map((diff) => updateRowSavedBeforeRename(isLegacyAttributes(saved), diff)),
            ),
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
          let provenOwned = false;
          const findAppInProject = Effect.gen(function* () {
            const projectId = unresolvedProjectIdOf(olds.project);
            if (!projectId) return undefined;
            const byLogicalId = yield* findAppByLogicalId(projectId, olds.logicalId ?? fqn, olds);
            if (byLogicalId) {
              // A logical ID alone does not prove ownership: another
              // declaration, stage, or stack on the branch can hold it.
              // The generated display name embeds this instance's ID,
              // so a match on it is this resource's interrupted create.
              provenOwned =
                olds.displayName === undefined &&
                byLogicalId.name === (yield* createDisplayName(id, undefined));
              return byLogicalId;
            }
            // An explicit logical ID is the only identity. A derived one
            // falls back to the display name for services created before
            // logical IDs existed.
            if (olds.logicalId !== undefined) return undefined;
            return yield* findApp(projectId, yield* createDisplayName(id, olds.displayName), olds);
          });
          const app = serviceId
            ? yield* getService({ serviceId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : yield* findAppInProject;
          if (!app) return undefined;
          const attrs = attrsFrom(app);
          return serviceId || provenOwned ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news, output: saved }) {
          const output = saved && currentAttributes(saved);
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
            : undefined;
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
          yield* ensureAppImmutableIdentity(
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
          return attrsFrom(app);
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
  devProvider(ComputeService, ["serviceId"], ({ id, fqn, news }) => ({
    serviceId: devId("app", id),
    name: news.displayName ?? id,
    projectId: attrOrString(news.project, "projectId"),
    regionId: news.regionId ?? "us-east-1",
    branchId: news.branchId ?? null,
    latestVersionId: null,
    serviceEndpointDomain: "localhost",
    createdAt: DEV_TIMESTAMP,
    logicalId: news.logicalId ?? fqn,
  }));

export const ComputeServiceProvider = () =>
  ProviderLayer.dual(ComputeService, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
