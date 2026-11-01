import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * The registry a server-rendered site's image goes to. A registry login isn't
 * something STACKIT credentials provide, so this needs
 * `STACKIT_TEST_HARBOR_USERNAME` and `STACKIT_TEST_HARBOR_SECRET`.
 */
const identity = {
  username: Config.String("STACKIT_TEST_HARBOR_USERNAME"),
  secret: Config.Redacted("STACKIT_TEST_HARBOR_SECRET"),
};

const Images = Stackit.ContainerRegistry.Project("StackitWebsiteImages", {
  forceDestroy: true,
  harborCredentials: identity,
});

const Pusher = Effect.gen(function* () {
  const images = yield* Images;
  return yield* Stackit.ContainerRegistry.RobotAccount("StackitWebsitePusher", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
    ],
  });
});

const Puller = Effect.gen(function* () {
  const images = yield* Images;
  const robot = yield* Stackit.ContainerRegistry.RobotAccount("StackitWebsitePuller", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [{ resource: "repository", action: "pull" }],
  });
  return yield* Stackit.Functions.PullCredential("StackitWebsitePullCredential", {
    address: images.registryHost,
    username: robot.robotName,
    password: robot.secret,
  });
});

/** The `registry` and `pullCredential` props of one fixture's site. */
export const hostingFor = (image: string) =>
  Effect.gen(function* () {
    const images = yield* Images;
    const pusher = yield* Pusher;
    const puller = yield* Puller;
    return {
      registry: {
        repository: Output.interpolate`${images.imagePrefix}/${image}`,
        username: pusher.robotName,
        password: pusher.secret,
      },
      pullCredential: puller.pullCredentialId,
    };
  });
