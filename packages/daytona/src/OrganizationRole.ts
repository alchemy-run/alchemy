import * as organizations from "@distilled.cloud/daytona/organizations";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Permission } from "./ApiKey.ts";
import { declarable } from "./internal/Declared.ts";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import {
  currentOrganizationId,
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import type { Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationRoleProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /**
   * Role name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Renames update in place.
   */
  name?: string;
  /** What the role is for. */
  description?: string;
  /** Permissions members with this role get. Updated in place. */
  permissions: Permission[];
}

export interface OrganizationRoleAttributes {
  /** Role ID; what invitations and member access take. */
  roleId: string;
  /** Organization the role belongs to. */
  organizationId: string;
  /** Role name. */
  name: string;
  /** Description. */
  description: string;
  /** Permissions the role grants. */
  permissions: Permission[];
}

export type OrganizationRole = Resource<
  "Daytona.OrganizationRole",
  OrganizationRoleProps,
  OrganizationRoleAttributes,
  never,
  Providers
>;

/**
 * A custom role in the Daytona organization: a named set of permissions to
 * give members, through {@link OrganizationInvitation} or
 * {@link OrganizationMember}.
 * @see https://www.daytona.io/docs/en/organizations/
 *
 * ### Creating a Role
 * **Example:** A role that can run sandboxes but not manage images
 * ```typescript
 * export const Developer = Daytona.OrganizationRole("Developer", {
 *   description: "Run sandboxes",
 *   permissions: ["write:sandboxes", "delete:sandboxes", "read:volumes"],
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationRole = declarable<OrganizationRole>()(
  Resource<OrganizationRole>("Daytona.OrganizationRole"),
);

const toAttributes = (
  organizationId: string,
  r: organizations.OrganizationRole,
): OrganizationRoleAttributes => ({
  roleId: r.id,
  organizationId,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
});

const listRoles = (organizationId: string) =>
  organizations.listOrganizationRoles({ organizationId });

const sorted = (permissions: readonly string[]) => [...permissions].sort();

export const OrganizationRoleProvider = () =>
  Provider.effect(
    OrganizationRole,
    Effect.succeed({
      stables: ["roleId", "organizationId"],
      list: Effect.fn(function* () {
        const organizationId = yield* currentOrganizationId;
        const roles = yield* listRoles(organizationId);
        return roles.filter((r) => !r.isGlobal).map((r) => toAttributes(organizationId, r));
      }),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const name = yield* resolveName(id, olds?.name, output?.name);
        const roles = yield* listRoles(organizationId);
        const found =
          roles.find((r) => r.id === output?.roleId) ?? roles.find((r) => r.name === name);
        if (found === undefined) return undefined;
        const attrs = toAttributes(organizationId, found);
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const organizationId = yield* organizationIdFor(news.organization);
        const name = yield* resolveName(id, news.name, output?.name);
        const description = news.description ?? "";
        // Observe
        const roles = yield* listRoles(organizationId);
        const current =
          roles.find((r) => r.id === output?.roleId) ?? roles.find((r) => r.name === name);
        // Ensure
        if (current === undefined) {
          const created = yield* organizations
            .createOrganizationRole({
              organizationId,
              name,
              description,
              permissions: news.permissions,
            })
            .pipe(Effect.catchTag("OrganizationRoleAlreadyExists", () => Effect.undefined));
          if (created) return toAttributes(organizationId, created);
        }
        const existing = current ?? (yield* listRoles(organizationId)).find((r) => r.name === name);
        if (existing === undefined) {
          return yield* Effect.die(`Daytona role ${name} vanished during create`);
        }
        // Sync against observed state.
        if (
          existing.name === name &&
          existing.description === description &&
          deepEqual(sorted(existing.permissions), sorted(news.permissions))
        ) {
          return toAttributes(organizationId, existing);
        }
        const updated = yield* organizations.updateOrganizationRole({
          organizationId,
          roleId: existing.id,
          name,
          description,
          permissions: news.permissions,
        });
        return toAttributes(organizationId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* organizations
          .deleteOrganizationRole({ organizationId: output.organizationId, roleId: output.roleId })
          .pipe(Effect.catchTag("OrganizationRoleNotFound", () => Effect.void));
      }),
    }),
  );
