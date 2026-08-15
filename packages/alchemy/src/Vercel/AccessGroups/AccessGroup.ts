import * as accessGroups from "@distilled.cloud/vercel/access_groups";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { listAllAccessGroups, teamScope } from "./internal.ts";

export type AccessGroupProps = {
  /**
   * Name of the access group. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`. Renaming an existing access group updates it
   * in place.
   */
  name?: string;
  /**
   * Team member user IDs that belong to the access group. When set (even to
   * an empty array), membership is converged exactly — members present on
   * the group but absent from this list are removed. When omitted,
   * membership is left unmanaged.
   */
  members?: string[];
};

export type AccessGroup = Resource<
  "Vercel.AccessGroup",
  AccessGroupProps,
  {
    /** ID of the access group (`ag_…`). */
    accessGroupId: string;
    /** Name of the access group. */
    name: string;
    /** ID of the team the access group belongs to. */
    teamId: string;
    /** Timestamp in milliseconds when the access group was created. */
    createdAt: string;
    /** Timestamp in milliseconds when the access group was last updated. */
    updatedAt: string;
    /** Number of members in the access group. */
    membersCount: number;
    /** Number of projects attached to the access group. */
    projectsCount: number;
    /** User IDs of the group's members as last observed. */
    members: string[];
  },
  never,
  Providers
>;

/**
 * A Vercel Access Group — a named collection of team members that can be
 * granted a shared role on specific projects.
 *
 * Access Groups are an Enterprise-plan feature: on non-Enterprise teams every
 * access-group API call (including reads) fails with a typed `Forbidden`
 * error ("You don't have permission to … the access group").
 *
 * @resource
 * @section Creating an Access Group
 * @example Basic access group
 * ```typescript
 * const group = yield* Vercel.AccessGroup("my-group");
 * ```
 *
 * @example Access group with an explicit name
 * ```typescript
 * const group = yield* Vercel.AccessGroup("my-group", {
 *   name: "frontend-team",
 * });
 * ```
 *
 * @section Managing members
 * @example Access group with managed membership
 * ```typescript
 * const group = yield* Vercel.AccessGroup("my-group", {
 *   members: ["uid1", "uid2"],
 * });
 * ```
 *
 * @section Attaching projects
 * @example Grant the group a role on a project
 * ```typescript
 * const group = yield* Vercel.AccessGroup("my-group");
 * const grant = yield* Vercel.AccessGroupProject("my-grant", {
 *   accessGroup: group,
 *   projectId: "prj_123",
 *   role: "PROJECT_VIEWER",
 * });
 * ```
 *
 * @see https://vercel.com/docs/rbac/access-groups
 */
export const AccessGroup = Resource<AccessGroup>("Vercel.AccessGroup");

export const AccessGroupProvider = () =>
  Provider.succeed(AccessGroup, {
    stables: ["accessGroupId", "teamId", "createdAt"],
    read: Effect.fn(function* ({ id, output, olds }) {
      const scope = yield* teamScope;
      // Prefer the stable id from prior output; fall back to the
      // deterministic name for the state-loss recovery path (`idOrName`
      // accepts either).
      const idOrName =
        output?.accessGroupId ??
        olds?.name ??
        (yield* createAccessGroupName(id));
      const observed = yield* accessGroups
        .readAccessGroup({ idOrName, ...scope })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (observed === undefined) return undefined;
      const members = yield* listAllAccessGroupMembers(
        observed.accessGroupId,
        scope,
      );
      return {
        accessGroupId: observed.accessGroupId,
        name: observed.name,
        teamId: observed.teamId,
        createdAt: observed.createdAt,
        updatedAt: observed.updatedAt,
        membersCount: observed.membersCount,
        projectsCount: observed.projectsCount,
        members,
      };
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* teamScope;
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts. An
      // explicit `news.name` still renames the group in place.
      const name =
        news.name ?? output?.name ?? (yield* createAccessGroupName(id));

      // Observe — cloud state is authoritative; `output` is only a cache of
      // the stable id.
      const observed = yield* accessGroups
        .readAccessGroup({
          idOrName: output?.accessGroupId ?? name,
          ...scope,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      // Ensure — missing → create with the desired membership.
      if (observed === undefined) {
        const created = yield* accessGroups.createAccessGroup({
          name,
          ...(news.members !== undefined && news.members.length > 0
            ? { membersToAdd: news.members }
            : {}),
          ...scope,
        });
        return {
          accessGroupId: created.accessGroupId,
          name: created.name,
          teamId: created.teamId,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          membersCount: created.membersCount,
          projectsCount: created.projectsCount,
          members: news.members ?? [],
        };
      }

      // Sync — diff OBSERVED members (not olds/output) against desired and
      // apply only the delta. `members` undefined = membership unmanaged.
      const observedMembers = yield* listAllAccessGroupMembers(
        observed.accessGroupId,
        scope,
      );
      const desiredMembers = news.members;
      const membersToAdd =
        desiredMembers?.filter((m) => !observedMembers.includes(m)) ?? [];
      const membersToRemove =
        desiredMembers !== undefined
          ? observedMembers.filter((m) => !desiredMembers.includes(m))
          : [];
      const rename = name !== observed.name;
      if (rename || membersToAdd.length > 0 || membersToRemove.length > 0) {
        const updated = yield* accessGroups.updateAccessGroup({
          idOrName: observed.accessGroupId,
          ...(rename ? { name } : {}),
          ...(membersToAdd.length > 0 ? { membersToAdd } : {}),
          ...(membersToRemove.length > 0 ? { membersToRemove } : {}),
          ...scope,
        });
        return {
          accessGroupId: updated.accessGroupId,
          name: updated.name,
          teamId: updated.teamId,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          membersCount: updated.membersCount,
          projectsCount: updated.projectsCount,
          members: news.members ?? observedMembers,
        };
      }
      return {
        accessGroupId: observed.accessGroupId,
        name: observed.name,
        teamId: observed.teamId,
        createdAt: observed.createdAt,
        updatedAt: observed.updatedAt,
        membersCount: observed.membersCount,
        projectsCount: observed.projectsCount,
        members: observedMembers,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      const scope = yield* teamScope;
      yield* accessGroups
        .deleteAccessGroup({ idOrName: output.accessGroupId, ...scope })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const scope = yield* teamScope;
      const groups = yield* listAllAccessGroups(scope);
      return groups.map((g) => ({
        accessGroupId: g.accessGroupId,
        name: g.name,
        teamId: g.teamId,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        membersCount: g.membersCount,
        projectsCount: g.projectsCount,
        members: [...(g.members ?? [])],
      }));
    }),
  });

const createAccessGroupName = (id: string) => createPhysicalName({ id });

const listAllAccessGroupMembers = (
  idOrName: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const members: string[] = [];
    let next: string | undefined;
    do {
      const page = yield* accessGroups.listAccessGroupMembers({
        idOrName,
        limit: 100,
        ...(next !== undefined ? { next } : {}),
        ...scope,
      });
      for (const m of page.members) members.push(m.uid);
      next = page.pagination.next ?? undefined;
    } while (next !== undefined);
    return members;
  });
