import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * Your Harbor user and CLI secret, from your user profile in the registry UI.
 * They create the robots below, and empty the project on destroy.
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

/** The login Alchemy pushes images with. */
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

/** The pull-only login STACKIT Functions fetches the images with. */
export const Puller = Effect.gen(function* () {
  const images = yield* Images;
  const robot = yield* Stackit.ContainerRegistry.RobotAccount("Puller", {
    project: images.name,
    registryUrl: images.url,
    credentials: harbor,
    permissions: [{ resource: "repository", action: "pull" }],
  });
  return yield* Stackit.Functions.PullCredential("PullCredential", {
    address: images.registryHost,
    username: robot.robotName,
    password: robot.secret,
  });
});

/** Where the image of one Function is pushed. */
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
