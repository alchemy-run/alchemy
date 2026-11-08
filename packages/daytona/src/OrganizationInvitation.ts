import * as organizations from "@distilled.cloud/daytona/organizations";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { declarable } from "./internal/Declared.ts";
import {
  currentOrganizationId,
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";

/** A role, by id. Accepts a `Daytona.OrganizationRole` or `{ roleId }`. */
export type RoleRef = { readonly roleId: string };

/** `owner` manages the organization; `member` gets only the assigned roles. */
export type MemberRole = "owner" | "member";

export interface OrganizationInvitationProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /** Email to invite. Changing it replaces the invitation. */
  email: string;
  /** Base role. @default "member" */
  role?: MemberRole;
  /** Custom roles to assign. Updated in place. */
  roles?: Ref<RoleRef>[];
  /** When the invitation expires, as an ISO 8601 timestamp. */
  expiresAt?: string;
}

export interface OrganizationInvitationAttributes {
  /** Invitation ID. */
  invitationId: string;
  /** Organization ID. */
  organizationId: string;
  /** Invited email. */
  email: string;
  /** `pending`, `accepted`, `declined`, `cancelled`. */
  status: string;
  /** When it expires. */
  expiresAt: string;
}

export type OrganizationInvitation = Resource<
  "Daytona.OrganizationInvitation",
  OrganizationInvitationProps,
  OrganizationInvitationAttributes,
  never,
  Providers
>;

/**
 * Invite someone to the Daytona organization by email, with a base role
 * and custom {@link OrganizationRole}s. Destroying it cancels the
 * invitation if it hasn't been accepted; an accepted invitation leaves the
 * member in place.
 *
 * ### Inviting a Developer
 * **Example:** A member with a custom role
 * ```typescript
 * export const Alice = Daytona.OrganizationInvitation("Alice", {
 *   email: "alice@example.com",
 *   roles: [Developer],
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationInvitation = declarable<OrganizationInvitation>()(
  Resource<OrganizationInvitation>("Daytona.OrganizationInvitation"),
);

const resolveRoles = (roles: OrganizationInvitationProps["roles"]) =>
  Effect.succeed((roles ?? []).map((r) => resolved(r).roleId));

const toAttributes = (
  i: organizations.OrganizationInvitation,
): OrganizationInvitationAttributes => ({
  invitationId: i.id,
  organizationId: i.organizationId,
  email: i.email,
  status: i.status,
  expiresAt: i.expiresAt,
});

export const OrganizationInvitationProvider = () =>
  Provider.effect(
    OrganizationInvitation,
    Effect.succeed({
      stables: ["invitationId", "organizationId"],
      list: Effect.fn(function* () {
        const organizationId = yield* currentOrganizationId;
        return (yield* organizations.listOrganizationInvitations({ organizationId })).map(
          toAttributes,
        );
      }),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
        if (news.email !== output.email) return { action: "replace" } as const;
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        const all = yield* organizations.listOrganizationInvitations({
          organizationId: output.organizationId,
        });
        const found = all.find((i) => i.id === output.invitationId);
        return found ? toAttributes(found) : undefined;
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = yield* organizationIdFor(news.organization);
        const assignedRoleIds = yield* resolveRoles(news.roles);
        const role = news.role ?? "member";
        // Observe the pending invitation for this email.
        const all = yield* organizations.listOrganizationInvitations({ organizationId });
        const current =
          all.find((i) => i.id === output?.invitationId) ??
          all.find((i) => i.email === news.email && i.status === "pending");
        // Ensure
        if (current === undefined || current.status !== "pending") {
          if (current?.status === "accepted") return toAttributes(current);
          return toAttributes(
            yield* organizations.createOrganizationInvitation({
              organizationId,
              email: news.email,
              role,
              assignedRoleIds,
              expiresAt: news.expiresAt,
            }),
          );
        }
        // Sync
        const observedRoles = current.assignedRoles.map((r) => r.id).sort();
        if (
          current.role === role &&
          deepEqual(observedRoles, [...assignedRoleIds].sort()) &&
          (news.expiresAt === undefined || news.expiresAt === current.expiresAt)
        ) {
          return toAttributes(current);
        }
        return toAttributes(
          yield* organizations.updateOrganizationInvitation({
            organizationId,
            invitationId: current.id,
            role,
            assignedRoleIds,
            expiresAt: news.expiresAt,
          }),
        );
      }),
      delete: Effect.fn(function* ({ output }) {
        const all = yield* organizations.listOrganizationInvitations({
          organizationId: output.organizationId,
        });
        const found = all.find((i) => i.id === output.invitationId);
        if (found?.status !== "pending") return;
        yield* organizations
          .cancelOrganizationInvitation({
            organizationId: output.organizationId,
            invitationId: output.invitationId,
          })
          .pipe(Effect.catchTag("OrganizationInvitationNotFound", () => Effect.void));
      }),
    }),
  );
