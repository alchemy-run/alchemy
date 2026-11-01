import * as scf from "@distilled.cloud/stackit/scf";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { resolveProjectScope } from "../IaaS/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteRoleAs,
  findRole,
  isLoginsOwnRole,
  observeRole,
  roleDiff,
  roleTarget,
  roleUser,
  usableCredentials,
  type RoleAttributes,
  type RoleProps,
  withCloudFoundry,
} from "./internal.ts";

/** What a user may do in an organization. */
export type OrganizationRoleType =
  | "organization_user"
  | "organization_auditor"
  | "organization_manager"
  | "organization_billing_manager";

export interface OrganizationRoleProps extends RoleProps {
  /** The role to grant. Changing it replaces the role. */
  type: OrganizationRoleType;
}

export interface OrganizationRoleAttributes extends RoleAttributes {
  /** The role. */
  type: string;
}

export type OrganizationRole = Resource<
  "Stackit.CloudFoundry.OrganizationRole",
  OrganizationRoleProps,
  OrganizationRoleAttributes,
  never,
  Providers
>;

/**
 * A role of a user in a STACKIT Cloud Foundry organization.
 *
 * STACKIT's API only creates roles, so reading and deleting one goes through the
 * platform's Cloud Foundry API, with the `credentials` of a user who may do that, usually
 * the organization manager. Everything except the credentials replaces the role, and the
 * old role is deleted first, because the API answers the existing role for the same grant.
 *
 * Roles have no labels. With `userGuid`, a role the user already holds without state is
 * reported as unowned, and only taken over with `--adopt`. With `userName` it can't be
 * recognized in time. See the prop.
 *
 * ### Granting a Role
 * **Example:** Make a user an auditor of an organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const manager = yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
 *   organizationId: organization.organizationId,
 * });
 * yield* Stackit.CloudFoundry.OrganizationRole("Auditor", {
 *   organizationId: organization.organizationId,
 *   type: "organization_auditor",
 *   userName: "alice@example.com",
 *   credentials: {
 *     apiUrl: manager.apiUrl,
 *     username: manager.username,
 *     password: manager.password,
 *   },
 * });
 * ```
 *
 * :::caution[Changing the user or type replaces the Role]
 * The user loses the old role before they get the new one.
 * :::
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const OrganizationRole = Resource<OrganizationRole>("Stackit.CloudFoundry.OrganizationRole");

const resourceOf = (roleId: string) => `STACKIT Cloud Foundry organization role ${roleId}`;

export const OrganizationRoleProvider = () =>
  Provider.succeed(OrganizationRole, {
    stables: ["roleId", "organizationId", "platformId", "projectId", "region", "type"],
    nuke: { dependsOn: ["Stackit.CloudFoundry.Organization"] },

    // Listing needs Cloud Foundry credentials, which nuke doesn't have and only state
    // holds. Roles go with their organization.
    list: () => Effect.succeed([]),

    diff: roleDiff<OrganizationRoleProps, OrganizationRoleAttributes>(
      ["organizationId", "userGuid", "userName", "type", "projectId", "region"],
      (resolved, output) => resolved.type === output.type,
    ),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      if (!usableCredentials(olds?.credentials)) return undefined;
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const live = yield* observeRole(id, olds.credentials, output.roleId);
        return live === undefined
          ? undefined
          : { ...output, userGuid: roleUser(live) ?? output.userGuid };
      }
      if (olds.userGuid === undefined) return undefined;
      const { organizationId, userGuid, type } = olds;
      const found = yield* findRole({ type, userGuid, organizationId }).pipe(
        withCloudFoundry(id, olds.credentials),
      );
      if (found?.guid === undefined) return undefined;
      const attrs: OrganizationRoleAttributes = {
        roleId: found.guid,
        organizationId,
        platformId: previous?.platformId ?? "",
        userGuid,
        userName: olds.userName,
        projectId: scope.projectId,
        region: scope.region,
        type,
        heldByLogin: previous?.heldByLogin ?? false,
      };
      return previous?.roleId === found.guid ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const { organizationId, type } = news;

      // 1. Observe. An id only speaks for this role where it was granted.
      const known =
        output?.organizationId === organizationId &&
        output.projectId === scope.projectId &&
        output.region === scope.region &&
        output.type === type
          ? output
          : undefined;
      const live =
        known !== undefined ? yield* observeRole(id, news.credentials, known.roleId) : undefined;
      if (known !== undefined && live !== undefined) {
        const userGuid = roleUser(live) ?? known.userGuid;
        return {
          ...known,
          userGuid,
          heldByLogin: yield* isLoginsOwnRole(scope, organizationId, news.credentials, userGuid),
        };
      }

      // 2. Ensure. The API answers the existing role if the user already holds it.
      const created = yield* scf.createOrgRole({
        ...scope,
        organizationId,
        type,
        ...roleTarget(news),
      });
      const role = yield* observeRole(id, news.credentials, created.guid);
      const userGuid = roleUser(role) ?? news.userGuid;
      return {
        roleId: created.guid,
        organizationId,
        platformId: created.platformId,
        userGuid,
        userName: news.userName,
        projectId: scope.projectId,
        region: scope.region,
        type,
        heldByLogin: yield* isLoginsOwnRole(scope, organizationId, news.credentials, userGuid),
      };
    }),

    delete: Effect.fn(function* ({ id, olds, output }) {
      yield* deleteRoleAs(id, resourceOf(output.roleId), olds.credentials, output);
    }),
  });
