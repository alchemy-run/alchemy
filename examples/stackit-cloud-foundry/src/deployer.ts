import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * An organization, a space in it, and a manager who may deploy to that space. An app takes
 * `role.spaceId`, not `space.spaceId`, so it deploys after the manager holds the role.
 */
export const Stage = Effect.gen(function* () {
  const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
  const manager = yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
    organizationId: organization.organizationId,
  });
  const credentials = {
    apiUrl: manager.apiUrl,
    username: manager.username,
    password: manager.password,
  };
  const space = yield* Stackit.CloudFoundry.Space("Dev", {
    organizationId: organization.organizationId,
    credentials,
  });
  const role = yield* Stackit.CloudFoundry.SpaceRole("Developer", {
    organizationId: organization.organizationId,
    spaceId: space.spaceId,
    type: "space_developer",
    userGuid: manager.userId,
    credentials,
  });
  return { organization, space, manager, credentials, role };
});

/**
 * Your Harbor user and CLI secret, from your user profile in the registry UI.
 * They create the robot below, and empty the project on destroy.
 */
const harbor = {
  username: Config.String("HARBOR_USERNAME"),
  secret: Config.Redacted("HARBOR_CLI_SECRET"),
};

/** The Container Registry project the images go to. */
export const Images = Stackit.ContainerRegistry.Project("Images", {
  forceDestroy: true,
  harborCredentials: harbor,
});

/** The login Alchemy pushes images with, and Cloud Foundry pulls them with. */
export const Pusher = Effect.gen(function* () {
  const images = yield* Images;
  return yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
    project: images.name,
    registryUrl: images.url,
    credentials: harbor,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
    ],
  });
});

/** Where the image of one App is pushed. */
export const registryFor = (image: string) =>
  Effect.gen(function* () {
    const images = yield* Images;
    const pusher = yield* Pusher;
    return {
      repository: Output.interpolate`${images.imagePrefix}/${image}`,
      username: pusher.robotName,
      password: pusher.secret,
    };
  });
