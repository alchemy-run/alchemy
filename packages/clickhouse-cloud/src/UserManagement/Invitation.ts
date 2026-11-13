import * as users from "@distilled.cloud/clickhouse-cloud/user_management";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import type { Providers } from "../Providers.ts";

/** A role an invitation assigns. */
export interface InvitationRole {
  /** Role ID. */
  roleId: string;
  /** Role name. */
  roleName: string | undefined;
  /** `system` or `custom`. */
  roleType: string | undefined;
}

export interface InvitationProps {
  /**
   * Email of the person to invite. Only a user with this email can accept.
   * Changing it replaces the invitation (a new email is sent).
   */
  email: string;
  /**
   * Roles the person gets on accepting: system role IDs or
   * `ClickHouseCloud.RoleManagement.Role` IDs. Changing them replaces the
   * invitation (a new email is sent): invitations have no update.
   */
  assignedRoleIds: string[];
}

export interface InvitationAttributes {
  /** Invitation ID. */
  invitationId: string;
  /** Organization ID. */
  organizationId: string;
  /** Invited email, lowercase. */
  email: string;
  /** When the invitation was sent. */
  createdAt: string | undefined;
  /** When the invitation expires. */
  expireAt: string | undefined;
  /** Roles the person gets on accepting. */
  assignedRoles: InvitationRole[];
  /** The member who accepted the invitation, once someone has. */
  acceptedUserId: string | undefined;
}

export type Invitation = Resource<
  "ClickHouseCloud.UserManagement.Invitation",
  InvitationProps,
  InvitationAttributes,
  never,
  Providers
>;

/**
 * An invitation to join the organization, sent by email, with the roles
 * the person gets when they accept.
 *
 * Creating the resource sends the email. Invitations have no update, so
 * any change of `email` or `assignedRoleIds` replaces it: the old
 * invitation is withdrawn and a new email goes out. Once the person
 * accepts, the invitation disappears from the API and the resource keeps
 * the member's ID in `acceptedUserId` instead of inviting them again.
 * Invitations carry no marker, so only one in state is alchemy's. Destroying
 * the resource withdraws a pending invitation; it never removes
 * a member who accepted (use `ClickHouseCloud.UserManagement.Member` for
 * that).
 * @see https://clickhouse.com/docs/cloud/security/manage-cloud-users
 *
 * ### Inviting People
 * **Example:** Invite a developer with read access to every service
 * ```typescript
 * yield* ClickHouseCloud.UserManagement.Invitation("Ada", {
 *   email: "ada@example.com",
 *   // the system "Service Reader" role
 *   assignedRoleIds: ["21111111-1111-1111-9999-000000000007"],
 * });
 * ```
 *
 * **Example:** Invite with a custom role
 * ```typescript
 * const analyst = yield* ClickHouseCloud.RoleManagement.Role("Analyst", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:service:view"],
 *       resources: ["instance/*"],
 *     },
 *   ],
 * });
 * yield* ClickHouseCloud.UserManagement.Invitation("Grace", {
 *   email: "grace@example.com",
 *   assignedRoleIds: [analyst.roleId],
 * });
 * ```
 *
 * :::caution
 * Every change replaces the invitation and sends a new email.
 * :::
 *
 * @resource
 * @product User Management
 */
export const Invitation = Resource<Invitation>("ClickHouseCloud.UserManagement.Invitation");

const toAttributes = (
  organizationId: string,
  invitation: users.Invitation,
  acceptedUserId: string | undefined,
): InvitationAttributes => ({
  invitationId: invitation.id ?? "",
  organizationId,
  email: invitation.email ?? "",
  createdAt: invitation.createdAt,
  expireAt: invitation.expireAt,
  assignedRoles: (invitation.assignedRoles ?? []).flatMap((r) =>
    r.roleId === undefined
      ? []
      : [{ roleId: r.roleId, roleName: r.roleName, roleType: r.roleType }],
  ),
  acceptedUserId,
});

const getInvitation = (organizationId: string, invitationId: string) =>
  users
    .getInvitation({ organizationId, invitationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findPending = (organizationId: string, email: string) =>
  users
    .listInvitations({ organizationId })
    .pipe(Effect.map((all) => all.find((i) => i.email === email.toLowerCase())));

const findMember = (organizationId: string, email: string) =>
  users
    .listMembers({ organizationId })
    .pipe(Effect.map((all) => all.find((m) => m.email?.toLowerCase() === email.toLowerCase())));

export const InvitationProvider = () =>
  Provider.effect(
    Invitation,
    Effect.succeed({
      stables: ["organizationId"],
      // Invitations carry no marker: only those in state are alchemy's.
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (
          news.email.toLowerCase() !== olds.email.toLowerCase() ||
          !deepEqual([...news.assignedRoleIds].sort(), [...olds.assignedRoleIds].sort())
        ) {
          // One pending invitation per address: withdraw the old one first.
          return { action: "replace", deleteFirst: true } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ output }) {
        // Invitations carry no marker, so one is alchemy's only through state.
        if (output === undefined) return undefined;
        if (output.acceptedUserId !== undefined) return output;
        const observed = yield* getInvitation(output.organizationId, output.invitationId);
        if (observed !== undefined) return toAttributes(output.organizationId, observed, undefined);
        const member = yield* findMember(output.organizationId, output.email);
        return member?.userId === undefined
          ? undefined
          : { ...output, acceptedUserId: member.userId };
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        // Observe: the invitation in state, or (after a create whose result
        // never reached state) a pending one for the address with these roles.
        const sameRoles = (i: users.Invitation) =>
          deepEqual(
            (i.assignedRoles ?? []).map((r) => r.roleId ?? "").sort(),
            [...news.assignedRoleIds].sort(),
          );
        const observed = output?.invitationId
          ? yield* getInvitation(organizationId, output.invitationId)
          : yield* findPending(organizationId, news.email).pipe(
              Effect.map((i) => (i !== undefined && sameRoles(i) ? i : undefined)),
            );
        if (observed !== undefined) return toAttributes(organizationId, observed, undefined);
        // Accepted: the person is a member, so nothing is sent again.
        if (output !== undefined) {
          const member = yield* findMember(organizationId, news.email);
          if (member?.userId !== undefined) return { ...output, acceptedUserId: member.userId };
        }
        // Ensure
        yield* session.note(`Inviting ${news.email}...`);
        const created = yield* users.createInvitation({
          organizationId,
          email: news.email,
          assignedRoleIds: news.assignedRoleIds,
        });
        return toAttributes(organizationId, created, undefined);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (output.acceptedUserId !== undefined || output.invitationId === "") return;
        yield* users
          .deleteInvitation({
            organizationId: output.organizationId,
            invitationId: output.invitationId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
