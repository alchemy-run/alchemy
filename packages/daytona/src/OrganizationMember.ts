import * as organizations from "@distilled.cloud/daytona/organizations";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { declarable } from "./internal/Declared.ts";
import {
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import type { MemberRole, RoleRef } from "./OrganizationInvitation.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationMemberProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /** The member, by user ID or email. Changing it replaces the resource. */
  user: string;
  /** Base role. */
  role: MemberRole;
  /** Custom roles. Updated in place. */
  roles?: Ref<RoleRef>[];
  /**
   * Remove the member from the organization on destroy. By default destroy
   * only puts back the access the member had before alchemy changed it.
   * @default false
   */
  removeOnDestroy?: boolean;
}

export interface OrganizationMemberAttributes {
  /** Organization ID. */
  organizationId: string;
  /** User ID. */
  userId: string;
  /** Email. */
  email: string;
  /** Base role. */
  role: string;
  /** Assigned custom role IDs. */
  roleIds: string[];
  /** Access before alchemy first changed it; restored on destroy. */
  original: { role: string; roleIds: string[] };
  /** Whether destroy removes the member. */
  removeOnDestroy: boolean;
}

export type OrganizationMember = Resource<
  "Daytona.OrganizationMember",
  OrganizationMemberProps,
  OrganizationMemberAttributes,
  never,
  Providers
>;

/** No member of the organization has that user ID or email. */
export class MemberNotInOrganization extends Data.TaggedError("Daytona.MemberNotInOrganization")<{
  readonly user: string;
}> {
  override get message() {
    return `${this.user} is not a member of the Daytona organization; invite them with Daytona.OrganizationInvitation`;
  }
}

/**
 * The access of an existing member of the Daytona organization: their
 * base role and custom {@link OrganizationRole}s. Use it to manage who can
 * do what as code. To add someone, use {@link OrganizationInvitation}.
 *
 * ### Granting a Role
 * **Example:** Make a member a developer
 * ```typescript
 * export const Bob = Daytona.OrganizationMember("Bob", {
 *   user: "bob@example.com",
 *   role: "member",
 *   roles: [Developer],
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationMember = declarable<OrganizationMember>()(
  Resource<OrganizationMember>("Daytona.OrganizationMember"),
);

const findMember = Effect.fn(function* (organizationId: string, user: string) {
  const members = yield* organizations.listOrganizationMembers({ organizationId });
  return members.find((m) => m.userId === user || m.email === user);
});

const toAttributes = (
  m: organizations.OrganizationUser,
  original: OrganizationMemberAttributes["original"],
  removeOnDestroy: boolean,
): OrganizationMemberAttributes => ({
  organizationId: m.organizationId,
  userId: m.userId,
  email: m.email,
  role: m.role,
  roleIds: m.assignedRoles.map((r) => r.id).sort(),
  original,
  removeOnDestroy,
});

export const OrganizationMemberProvider = () =>
  Provider.effect(
    OrganizationMember,
    Effect.succeed({
      stables: ["organizationId", "userId", "original"],
      nuke: { skip: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
        if (news.user !== output.userId && news.user !== output.email)
          return { action: "replace" } as const;
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        const found = yield* findMember(output.organizationId, output.userId);
        return found ? toAttributes(found, output.original, output.removeOnDestroy) : undefined;
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = yield* organizationIdFor(news.organization);
        const member = yield* findMember(organizationId, output?.userId ?? news.user);
        if (member === undefined) return yield* new MemberNotInOrganization({ user: news.user });
        const original = output?.original ?? {
          role: member.role,
          roleIds: member.assignedRoles.map((r) => r.id).sort(),
        };
        const roleIds = (news.roles ?? []).map((r) => resolved(r).roleId).sort();
        if (
          member.role !== news.role ||
          !deepEqual(member.assignedRoles.map((r) => r.id).sort(), roleIds)
        ) {
          yield* organizations.updateAccessForOrganizationMember({
            organizationId,
            userId: member.userId,
            role: news.role,
            assignedRoleIds: roleIds,
          });
        }
        const updated = yield* findMember(organizationId, member.userId);
        return toAttributes(updated ?? member, original, news.removeOnDestroy ?? false);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (output.removeOnDestroy) {
          yield* organizations
            .deleteOrganizationMember({
              organizationId: output.organizationId,
              userId: output.userId,
            })
            .pipe(Effect.catchTag("OrganizationMemberNotFound", () => Effect.void));
          return;
        }
        const member = yield* findMember(output.organizationId, output.userId);
        if (member === undefined) return;
        yield* organizations.updateAccessForOrganizationMember({
          organizationId: output.organizationId,
          userId: output.userId,
          role: output.original.role,
          assignedRoleIds: output.original.roleIds,
        });
      }),
    }),
  );
