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

/** What a user may do in a space. */
export type SpaceRoleType =
  | "space_auditor"
  | "space_developer"
  | "space_manager"
  | "space_supporter";

export interface SpaceRoleProps extends RoleProps {
  /** Space of the role. Changing it replaces the role. */
  spaceId: string;
  /** The role to grant. Changing it replaces the role. */
  type: SpaceRoleType;
}

export interface SpaceRoleAttributes extends RoleAttributes {
  /** Space of the role. */
  spaceId: string;
  /** The role. */
  type: string;
}

export type SpaceRole = Resource<
  "Stackit.CloudFoundry.SpaceRole",
  SpaceRoleProps,
  SpaceRoleAttributes,
  never,
  Providers
>;

/**
 * A role of a user in a STACKIT Cloud Foundry space. `space_developer` is what deploying
 * an app takes, and an organization manager doesn't hold it on its own.
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
 * See [STACKIT's Cloud Foundry docs](https://docs.stackit.cloud/products/runtime/cloud-foundry/).
 *
 * :::caution[Changing the user, space or type replaces the Role]
 * The user loses the old role before they get the new one.
 * :::
 *
 * ### Granting a Role
 * **Example:** Let the organization manager deploy to a space
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const space = yield* Stackit.CloudFoundry.Space("Dev", {
 *   organizationId: organization.organizationId,
 * });
 * const manager = yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
 *   organizationId: organization.organizationId,
 * });
 * yield* Stackit.CloudFoundry.SpaceRole("Deployer", {
 *   organizationId: organization.organizationId,
 *   spaceId: space.spaceId,
 *   type: "space_developer",
 *   userGuid: manager.userId,
 *   credentials: {
 *     apiUrl: manager.apiUrl,
 *     username: manager.username,
 *     password: manager.password,
 *   },
 * });
 * ```
 *
 * Rotating the organization manager with its `rotationKey` replaces a role held by that manager:
 * the old role went with the old user, so nothing is left to delete. A role of another user that
 * is replaced in the same deploy as the rotation can't sign in to be deleted, so change the two
 * in separate deploys.
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const SpaceRole = Resource<SpaceRole>("Stackit.CloudFoundry.SpaceRole");

const resourceOf = (roleId: string) => `STACKIT Cloud Foundry space role ${roleId}`;

export const SpaceRoleProvider = () =>
  Provider.succeed(SpaceRole, {
    stables: ["roleId", "organizationId", "spaceId", "platformId", "projectId", "region", "type"],
    nuke: { dependsOn: ["Stackit.CloudFoundry.Space"] },

    // Listing needs Cloud Foundry credentials, which nuke doesn't have and only state
    // holds. Roles go with their space.
    list: () => Effect.succeed([]),

    diff: roleDiff<SpaceRoleProps, SpaceRoleAttributes>(
      ["organizationId", "spaceId", "userGuid", "userName", "type", "projectId", "region"],
      (resolved, output) => resolved.type === output.type && resolved.spaceId === output.spaceId,
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
      const { organizationId, spaceId, userGuid, type } = olds;
      const found = yield* findRole({ type, userGuid, spaceId }).pipe(
        withCloudFoundry(id, olds.credentials),
      );
      if (found?.guid === undefined) return undefined;
      const attrs: SpaceRoleAttributes = {
        roleId: found.guid,
        organizationId,
        spaceId,
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
      const { organizationId, spaceId, type } = news;

      // 1. Observe. An id only speaks for this role where it was granted.
      const known =
        output?.organizationId === organizationId &&
        output.spaceId === spaceId &&
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
      const created = yield* scf.createSpaceRole({
        ...scope,
        organizationId,
        spaceId,
        type,
        ...roleTarget(news),
      });
      const role = yield* observeRole(id, news.credentials, created.guid);
      const userGuid = roleUser(role) ?? news.userGuid;
      return {
        roleId: created.guid,
        organizationId,
        spaceId,
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
