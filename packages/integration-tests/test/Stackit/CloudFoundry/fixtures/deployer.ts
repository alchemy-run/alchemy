import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";

/**
 * An organization, a space in it, and a manager with `space_developer` there. This module
 * also runs inside deployed apps, so it imports nothing test-only.
 */
export const deployer = (prefix: string) =>
  Effect.gen(function* () {
    const organization = yield* Stackit.CloudFoundry.Organization(`${prefix}Org`, {});
    const manager = yield* Stackit.CloudFoundry.OrganizationManager(`${prefix}Manager`, {
      organizationId: organization.organizationId,
    });
    const credentials = {
      apiUrl: manager.apiUrl,
      username: manager.username,
      password: manager.password,
    };
    const space = yield* Stackit.CloudFoundry.Space(`${prefix}Space`, {
      organizationId: organization.organizationId,
      credentials,
    });
    const role = yield* Stackit.CloudFoundry.SpaceRole(`${prefix}Developer`, {
      organizationId: organization.organizationId,
      spaceId: space.spaceId,
      type: "space_developer",
      userGuid: manager.userId,
      credentials,
    });
    return { organization, space, manager, credentials, role };
  });
