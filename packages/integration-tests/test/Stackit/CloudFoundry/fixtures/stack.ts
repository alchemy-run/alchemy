import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { deployer } from "./deployer.ts";

/**
 * The space the built apps deploy to, the registry their images go to, and the async app.
 * A registry login isn't something STACKIT credentials provide, so these need
 * `STACKIT_TEST_HARBOR_USERNAME` and `STACKIT_TEST_HARBOR_SECRET`.
 */
const identity = {
  username: Config.String("STACKIT_TEST_HARBOR_USERNAME"),
  secret: Config.Redacted("STACKIT_TEST_HARBOR_SECRET"),
};

export const Stage = deployer("Built");

export const Images = Stackit.ContainerRegistry.Project("StackitCloudFoundryImages", {
  forceDestroy: true,
  harborCredentials: identity,
});

export const Pusher = Effect.gen(function* () {
  const images = yield* Images;
  return yield* Stackit.ContainerRegistry.RobotAccount("StackitCloudFoundryPusher", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
    ],
  });
});

/** Where one fixture's image is pushed, and pulled from with the same login. */
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

/**
 * The async form, with the handler in `async-app.ts`. This module also runs inside the
 * deployed hosts, where the path means nothing and `import.meta.url` may not be a URL.
 */
export const Ping = Effect.gen(function* () {
  const stage = yield* Stage;
  const registry = yield* registryFor("ping");
  return yield* Stackit.CloudFoundry.App("StackitCloudFoundryPing", {
    spaceId: stage.space.spaceId,
    credentials: stage.credentials,
    main: globalThis.__ALCHEMY_RUNTIME__
      ? "async-app.ts"
      : new URL("./async-app.ts", import.meta.url).href,
    registry,
    memoryInMb: 256,
    env: { GREETING: "hello from async" },
  });
});

export type PingEnv = Stackit.InferEnv<typeof Ping>;
