import * as authorization from "@distilled.cloud/stackit/authorization";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  type AuthorizationResourceType,
  type AuthorizationScope,
  hasMember,
  resolveScope,
  sameScope,
  sameSubject,
} from "./internal/authorization.ts";

export type { AuthorizationResourceType } from "./internal/authorization.ts";

export type MembershipProps = {
  /**
   * The member: a user's email address, a service account's email
   * (`name-abc123@sa.stackit.cloud`), or a client or group identifier.
   * Changing it replaces the membership.
   */
  subject: string;
  /**
   * Role granted to the subject on the resource, e.g. `owner`, `editor`,
   * `reader`, or the `name` of a {@link CustomRole} defined on the same
   * resource. Lowercase letters separated by single `-` or `.`. Changing it
   * replaces the membership: the new role is granted before the old one is
   * removed, so the subject keeps access throughout.
   */
  role: string;
  /**
   * Kind of resource the membership is on. Changing it replaces the
   * membership.
   * @default "project"
   */
  resourceType?: AuthorizationResourceType;
  /**
   * Id of the project, folder or organization. Defaults to the profile's
   * project for `project` and to the profile's organization for
   * `organization`; required for `folder`. Changing it replaces the
   * membership.
   */
  resourceId?: string;
};

export type MembershipAttributes = {
  /** The member the role is granted to. */
  subject: string;
  /** The granted role. */
  role: string;
  /** Kind of resource the membership is on. */
  resourceType: AuthorizationResourceType;
  /** Id of the project, folder or organization. */
  resourceId: string;
};

export type Membership = Resource<
  "Stackit.IAM.Membership",
  MembershipProps,
  MembershipAttributes,
  never,
  Providers
>;

/**
 * Grants one role to one member (user, service account, client or group)
 * on a STACKIT project, folder or organization, through the STACKIT
 * Membership API — the counterpart of the Terraform
 * `stackit_authorization_project_role_assignment` family.
 *
 * Only this `subject` → `role` pair is managed: other members, and other
 * roles of the same subject, are left alone. A membership has nothing
 * mutable, so every prop change replaces it (grant the new pair, then
 * revoke the old one). Deploy blocks until the Membership API lists the
 * new member, and destroy until it no longer does.
 *
 * Ownership: memberships carry no labels, so Alchemy cannot mark one as
 * its own. A membership that already exists when the resource is first
 * deployed is reported as unowned and is only taken over with `--adopt`
 * (or `adopt(true)`), because destroying the resource revokes it. For the
 * same reason memberships are not enumerated by `alchemy unsafe nuke`; they
 * go away with the project, folder or organization they belong to.
 *
 * ### Granting a role on the project
 * **Example:** Make a service account an editor of the profile's project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.IAM.Membership("CiEditor", {
 *   subject: "ci-abc123@sa.stackit.cloud",
 *   role: "editor",
 * });
 * ```
 *
 * **Example:** Read-only access for a user on another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.IAM.Membership("AuditorReader", {
 *   subject: "auditor@example.com",
 *   role: "reader",
 *   resourceId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * ### Granting a role on a folder or organization
 * **Example:** Organization-wide reader
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // `resourceId` defaults to the profile's organization.
 * yield* Stackit.IAM.Membership("OrgReader", {
 *   subject: "auditor@example.com",
 *   role: "organization.member",
 *   resourceType: "organization",
 * });
 * ```
 *
 * **Example:** Folder member (a folder always needs its id)
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.IAM.Membership("TeamFolder", {
 *   subject: "team-lead@example.com",
 *   role: "folder.member",
 *   resourceType: "folder",
 *   resourceId: "11111111-1111-1111-1111-111111111111",
 * });
 * ```
 *
 * ### Granting a custom role
 * **Example:** Bind a custom role to a member
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const role = yield* Stackit.IAM.CustomRole("DnsOperator", {
 *   permissions: ["dns.zone.read", "dns.record.write"],
 * });
 * yield* Stackit.IAM.Membership("Operator", {
 *   subject: "operator@example.com",
 *   role: role.name,
 * });
 * ```
 *
 * ### Replacement cautions <!-- api-prose -->
 * Changing `role` or `subject` grants the new pair before revoking the old
 * one. Revoking can fail when STACKIT refuses to remove the last `owner`
 * of a resource; keep at least one other owner in place.
 *
 * @resource
 * @product STACKIT Authorization
 * @category IAM
 */
export const Membership = Resource<Membership>("Stackit.IAM.Membership");

const describeMembership = (scope: AuthorizationScope, subject: string, role: string) =>
  `STACKIT membership ${subject} as ${role} on ${scope.resourceType} ${scope.resourceId}`;

export const MembershipProvider = () =>
  Provider.succeed(Membership, {
    stables: ["subject", "role", "resourceType", "resourceId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Delete-first: the membership is its identity, with no generation
      // marker, and an unresolved prop can resolve to the current one.
      if (
        hasUnresolvedTrigger<MembershipProps>(news, [
          "resourceType",
          "resourceId",
          "subject",
          "role",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<MembershipProps>(news);
      const env = yield* StackitEnvironment.current;
      const scope = yield* resolveScope(resolved, env);
      if (
        !sameScope(scope, output) ||
        resolved.role !== output.role ||
        !sameSubject(resolved.subject, output.subject)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const subject = output?.subject ?? olds?.subject;
      const role = output?.role ?? olds?.role;
      if (subject === undefined || role === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const scope: AuthorizationScope =
        output !== undefined
          ? { resourceType: output.resourceType, resourceId: output.resourceId }
          : yield* resolveScope(olds ?? {}, env);
      const present = yield* hasMember(scope, subject, role);
      if (!present) return undefined;
      const attrs: MembershipAttributes = {
        subject,
        role,
        resourceType: scope.resourceType,
        resourceId: scope.resourceId,
      };
      // No ownership marker exists: a membership is ours when state already
      // records it (or it is the generation being replaced); one found
      // without state was granted by someone else.
      if (output !== undefined) return attrs;
      if (
        previous !== undefined &&
        sameScope(previous, scope) &&
        previous.role === role &&
        sameSubject(previous.subject, subject)
      ) {
        return attrs;
      }
      return Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* StackitEnvironment.current;
      const scope = yield* resolveScope(news, env);
      const { subject, role } = news;

      // Observe.
      const present = yield* hasMember(scope, subject, role);

      // Ensure. Adding an existing member is a no-op on the API side, so a
      // race with a concurrent grant converges either way.
      if (!present) {
        yield* authorization.addMembers({
          resourceId: scope.resourceId,
          resourceType: scope.resourceType,
          members: [{ subject, role }],
        });
        // Membership writes are eventually consistent: block until the
        // member list reflects the grant.
        yield* waitFor({
          resource: describeMembership(scope, subject, role),
          read: hasMember(scope, subject, role),
          ready: (listed) => listed,
          state: (listed) => (listed ? "present" : "absent"),
          timeout: "1 minute",
        });
      }

      // Nothing to sync: a membership is identity only.
      return {
        subject,
        role,
        resourceType: scope.resourceType,
        resourceId: scope.resourceId,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope: AuthorizationScope = {
        resourceType: output.resourceType,
        resourceId: output.resourceId,
      };
      const observe = hasMember(scope, output.subject, output.role);
      if (!(yield* observe)) return;
      yield* authorization.removeMembers({
        resourceId: scope.resourceId,
        resourceType: scope.resourceType,
        members: [{ subject: output.subject, role: output.role }],
      });
      yield* waitUntilGone({
        resource: describeMembership(scope, output.subject, output.role),
        read: observe.pipe(Effect.map((listed) => (listed ? ("present" as const) : undefined))),
        state: (listed) => listed,
        timeout: "1 minute",
      });
    }),
  });
