import * as accessGroups from "@distilled.cloud/vercel/access_groups";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { AccessGroup } from "./AccessGroup.ts";
import { listAllAccessGroups, teamScope } from "./internal.ts";

/** The access group to attach the project to. */
export type AccessGroupSource = AccessGroup | { accessGroupId: string };

/** The project role granted to the access group. */
export type AccessGroupProjectRole =
  | "ADMIN"
  | "PROJECT_VIEWER"
  | "PROJECT_DEVELOPER";

export type AccessGroupProjectProps = {
  /**
   * The access group (or `{ accessGroupId }`) to grant the role to.
   * Changing it replaces the attachment.
   */
  accessGroup: AccessGroupSource;
  /**
   * The ID of the project the role is granted on. Changing it replaces the
   * attachment.
   */
  projectId: string;
  /**
   * The project role granted to the access group's members.
   */
  role: AccessGroupProjectRole;
};

export type AccessGroupProject = Resource<
  "Vercel.AccessGroupProject",
  AccessGroupProjectProps,
  {
    /** ID of the access group (`ag_…`). */
    accessGroupId: string;
    /** ID of the project the role is granted on. */
    projectId: string;
    /** The granted project role. */
    role: AccessGroupProjectRole | "PROJECT_GUEST";
    /** ID of the team the access group belongs to. */
    teamId: string;
    /** Timestamp in milliseconds when the attachment was created. */
    createdAt: string;
    /** Timestamp in milliseconds when the attachment was last updated. */
    updatedAt: string;
  },
  never,
  Providers
>;

/**
 * Attaches a Vercel Access Group to a project with a project-level role,
 * granting every member of the group that role on the project.
 *
 * Access Groups are an Enterprise-plan feature: on non-Enterprise teams every
 * access-group API call (including reads) fails with a typed `Forbidden`
 * error.
 *
 * @resource
 * @section Granting a role on a project
 * @example Viewer role for a group
 * ```typescript
 * const group = yield* Vercel.AccessGroup("my-group");
 * const grant = yield* Vercel.AccessGroupProject("my-grant", {
 *   accessGroup: group,
 *   projectId: "prj_123",
 *   role: "PROJECT_VIEWER",
 * });
 * ```
 *
 * @example Developer role by access group id
 * ```typescript
 * const grant = yield* Vercel.AccessGroupProject("my-grant", {
 *   accessGroup: { accessGroupId: "ag_123" },
 *   projectId: "prj_123",
 *   role: "PROJECT_DEVELOPER",
 * });
 * ```
 *
 * @see https://vercel.com/docs/rbac/access-groups
 */
export const AccessGroupProject = Resource<AccessGroupProject>(
  "Vercel.AccessGroupProject",
);

export const AccessGroupProjectProvider = () =>
  Provider.succeed(AccessGroupProject, {
    stables: ["accessGroupId", "projectId", "teamId", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      // The attachment's identity is (accessGroupId, projectId) — changing
      // either replaces it. `accessGroupId` is a stable attribute of
      // AccessGroup, so the planner resolves `news.accessGroup` to a plain
      // object carrying it even when the group updates in place; an
      // Output-valued source that didn't survive a round-trip resolves to
      // undefined and falls through to the default update path.
      const oldAccessGroupId =
        output?.accessGroupId ??
        (olds.accessGroup !== undefined
          ? maybeResolveAccessGroupId(olds.accessGroup as AccessGroupSource)
          : undefined);
      const newAccessGroupId =
        "accessGroup" in news
          ? maybeResolveAccessGroupId(news.accessGroup as AccessGroupSource)
          : undefined;
      if (
        oldAccessGroupId !== undefined &&
        newAccessGroupId !== undefined &&
        oldAccessGroupId !== newAccessGroupId
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        output?.projectId !== undefined &&
        news.projectId !== output.projectId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output, olds }) {
      const scope = yield* teamScope;
      const accessGroupId =
        output?.accessGroupId ??
        (olds?.accessGroup !== undefined
          ? maybeResolveAccessGroupId(olds.accessGroup as AccessGroupSource)
          : undefined);
      const projectId = output?.projectId ?? olds?.projectId;
      if (accessGroupId === undefined || projectId === undefined) {
        return undefined;
      }
      return yield* accessGroups
        .readAccessGroupProject({
          accessGroupIdOrName: accessGroupId,
          projectId,
          ...scope,
        })
        .pipe(
          Effect.map(toAttributes),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* teamScope;
      const accessGroupId =
        output?.accessGroupId ?? resolveAccessGroupId(news.accessGroup);
      const projectId = output?.projectId ?? news.projectId;

      // Observe — the attachment may or may not exist regardless of output.
      const observed = yield* accessGroups
        .readAccessGroupProject({
          accessGroupIdOrName: accessGroupId,
          projectId,
          ...scope,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      // Ensure — missing → create the attachment with the desired role.
      if (observed === undefined) {
        const created = yield* accessGroups.createAccessGroupProject({
          accessGroupIdOrName: accessGroupId,
          projectId,
          role: news.role,
          ...scope,
        });
        return toAttributes(created);
      }

      // Sync — the role is the only mutable aspect; apply only the delta.
      if (observed.role !== news.role) {
        const updated = yield* accessGroups.updateAccessGroupProject({
          accessGroupIdOrName: accessGroupId,
          projectId,
          role: news.role,
          ...scope,
        });
        return toAttributes(updated);
      }
      return toAttributes(observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      const scope = yield* teamScope;
      // Idempotent — a 404 (attachment or the whole group already gone) is
      // success.
      yield* accessGroups
        .deleteAccessGroupProject({
          accessGroupIdOrName: output.accessGroupId,
          projectId: output.projectId,
          ...scope,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
    // Parent fan-out: attachments are scoped to an access group and there is
    // no account-wide enumeration API — enumerate every group, then list its
    // project attachments.
    list: Effect.fn(function* () {
      const scope = yield* teamScope;
      const groups = yield* listAllAccessGroups(scope);
      const perGroup = yield* Effect.forEach(
        groups,
        (group) =>
          Effect.gen(function* () {
            const rows = yield* listAllAccessGroupProjects(
              group.accessGroupId,
              scope,
            );
            return rows.map((row) => ({
              accessGroupId: group.accessGroupId,
              projectId: row.projectId,
              role: row.role,
              teamId: group.teamId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }));
          }),
        { concurrency: 5 },
      );
      return perGroup.flat();
    }),
  });

const toAttributes = (row: {
  accessGroupId: string;
  projectId: string;
  role: AccessGroupProjectRole | "PROJECT_GUEST";
  teamId: string;
  createdAt: string;
  updatedAt: string;
}) => ({
  accessGroupId: row.accessGroupId,
  projectId: row.projectId,
  role: row.role,
  teamId: row.teamId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const maybeResolveAccessGroupId = (
  source: AccessGroupSource,
): string | undefined => {
  if (source && "accessGroupId" in source && source.accessGroupId) {
    return source.accessGroupId as unknown as string;
  }
  return undefined;
};

const resolveAccessGroupId = (source: AccessGroupSource): string => {
  const accessGroupId = maybeResolveAccessGroupId(source);
  if (accessGroupId) return accessGroupId;
  throw new Error(
    "Invalid Vercel access group source: must be an AccessGroup or { accessGroupId }",
  );
};

const listAllAccessGroupProjects = (
  accessGroupId: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const rows: accessGroups.ListAccessGroupProjectsResponse["projects"][number][] =
      [];
    let next: string | undefined;
    do {
      const page = yield* accessGroups.listAccessGroupProjects({
        idOrName: accessGroupId,
        limit: 100,
        ...(next !== undefined ? { next } : {}),
        ...scope,
      });
      rows.push(...page.projects);
      next = page.pagination.next ?? undefined;
    } while (next !== undefined);
    return rows;
  });
