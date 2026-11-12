import * as users from "@distilled.cloud/clickhouse-cloud/user_management";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { MemberNotFound, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import type { InvitationRole } from "./Invitation.ts";

export interface MemberProps {
  /** The member's user ID. Changing it replaces the resource. */
  userId: string;
  /**
   * Roles the member acts with: system role IDs or
   * `ClickHouseCloud.RoleManagement.Role` IDs. Alchemy converges the member
   * to exactly these.
   */
  assignedRoleIds: string[];
  /**
   * Whether destroying the resource removes the person from the
   * organization. Otherwise destroy gives the member back the roles they
   * had when alchemy adopted them.
   * @default false
   */
  removeOnDestroy?: boolean;
}

export interface MemberAttributes {
  /** Organization ID. */
  organizationId: string;
  /** User ID. */
  userId: string;
  /** Name from the user's profile. */
  name: string | undefined;
  /** Email from the user's profile. */
  email: string | undefined;
  /** When the user joined. */
  joinedAt: string | undefined;
  /** Roles the member acts with. */
  assignedRoles: InvitationRole[];
  /** Role IDs the member had when alchemy adopted them; restored on destroy. */
  baselineRoleIds: string[];
}

export type Member = Resource<
  "ClickHouseCloud.UserManagement.Member",
  MemberProps,
  MemberAttributes,
  never,
  Providers
>;

/**
 * The roles of a person who is already a member of the organization.
 * Members can't be created through the API (people join by accepting a
 * `ClickHouseCloud.UserManagement.Invitation`), so this resource only
 * adopts one: deploying it for a member alchemy doesn't manage yet needs
 * `--adopt` (or `Alchemy.adopt(true)`), and the roles the member had then
 * are kept as `baselineRoleIds`.
 *
 * Destroying the resource gives the member those roles back, or removes
 * them from the organization when `removeOnDestroy` is true. A member who
 * left fails the deploy with `MemberNotFound`.
 * @see https://clickhouse.com/docs/cloud/security/manage-cloud-users
 *
 * ### Managing a Member's Roles
 * **Example:** Make an existing member an admin
 * ```typescript
 * yield* ClickHouseCloud.UserManagement.Member("Ada", {
 *   userId: "<user id from listMembers>",
 *   // the system "Admin" role
 *   assignedRoleIds: ["21111111-1111-1111-9999-000000000001"],
 * }).pipe(Alchemy.adopt(true));
 * ```
 *
 * **Example:** Offboard a contractor when the stack is destroyed
 * ```typescript
 * yield* ClickHouseCloud.UserManagement.Member("Contractor", {
 *   userId: "<user id>",
 *   assignedRoleIds: ["21111111-1111-1111-9999-000000000007"],
 *   removeOnDestroy: true,
 * }).pipe(Alchemy.adopt(true));
 * ```
 *
 * :::caution
 * `removeOnDestroy: true` removes the person from the organization on
 * destroy, and with them their access to every service.
 * :::
 *
 * @resource
 * @product User Management
 */
export const Member = Resource<Member>("ClickHouseCloud.UserManagement.Member");

const roleIdsOf = (member: users.Member) =>
  (member.assignedRoles ?? []).flatMap((r) => (r.roleId === undefined ? [] : [r.roleId]));

const toAttributes = (
  organizationId: string,
  member: users.Member,
  baselineRoleIds: string[],
): MemberAttributes => ({
  organizationId,
  userId: member.userId ?? "",
  name: member.name,
  email: member.email,
  joinedAt: member.joinedAt,
  assignedRoles: (member.assignedRoles ?? []).flatMap((r) =>
    r.roleId === undefined
      ? []
      : [{ roleId: r.roleId, roleName: r.roleName, roleType: r.roleType }],
  ),
  baselineRoleIds,
});

const getMember = (organizationId: string, userId: string) =>
  users.getMember({ organizationId, userId }).pipe(
    Effect.flatMap(requireResult("getMember")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const sameRoles = (a: readonly string[], b: readonly string[]) =>
  deepEqual([...a].sort(), [...b].sort());

export const MemberProvider = () =>
  Provider.effect(
    Member,
    Effect.succeed({
      stables: ["organizationId", "userId", "joinedAt", "baselineRoleIds"],
      // People are never alchemy's to nuke.
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.userId !== olds.userId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const userId = output?.userId ?? olds.userId;
        const observed = yield* getMember(organizationId, userId);
        if (observed === undefined) return undefined;
        // Not managed yet: adopting keeps the current roles as the baseline.
        if (output === undefined) {
          return Unowned(toAttributes(organizationId, observed, roleIdsOf(observed)));
        }
        return toAttributes(organizationId, observed, output.baselineRoleIds);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        // Observe
        let observed = yield* getMember(organizationId, news.userId);
        if (observed === undefined) return yield* new MemberNotFound({ userId: news.userId });
        const baselineRoleIds = output?.baselineRoleIds ?? roleIdsOf(observed);
        // Sync
        if (!sameRoles(roleIdsOf(observed), news.assignedRoleIds)) {
          observed = yield* users
            .updateMember({
              organizationId,
              userId: news.userId,
              assignedRoleIds: news.assignedRoleIds,
            })
            .pipe(Effect.flatMap(requireResult("updateMember")));
        }
        return toAttributes(organizationId, observed, baselineRoleIds);
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        const { organizationId, userId } = output;
        if (olds.removeOnDestroy === true) {
          yield* users
            .deleteMember({ organizationId, userId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          return;
        }
        const observed = yield* getMember(organizationId, userId);
        if (observed === undefined || sameRoles(roleIdsOf(observed), output.baselineRoleIds)) {
          return;
        }
        yield* users
          .updateMember({ organizationId, userId, assignedRoleIds: output.baselineRoleIds })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
