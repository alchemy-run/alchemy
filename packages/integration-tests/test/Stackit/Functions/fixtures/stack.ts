import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * The registry the built images go to, and the async function every fixture
 * binds to. A registry login isn't something STACKIT credentials provide, so these
 * need `STACKIT_TEST_HARBOR_USERNAME` and `STACKIT_TEST_HARBOR_SECRET`.
 */
const identity = {
  username: Config.String("STACKIT_TEST_HARBOR_USERNAME"),
  secret: Config.Redacted("STACKIT_TEST_HARBOR_SECRET"),
};

export const Images = Stackit.ContainerRegistry.Project("StackitFunctionsImages", {
  forceDestroy: true,
  harborCredentials: identity,
});

export const Pusher = Effect.gen(function* () {
  const images = yield* Images;
  return yield* Stackit.ContainerRegistry.RobotAccount("StackitFunctionsPusher", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
    ],
  });
});

/** A pull-only login, because this one lives on the Functions side. */
export const Puller = Effect.gen(function* () {
  const images = yield* Images;
  const robot = yield* Stackit.ContainerRegistry.RobotAccount("StackitFunctionsPuller", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [{ resource: "repository", action: "pull" }],
  });
  return yield* Stackit.Functions.PullCredential("StackitFunctionsPullCredential", {
    address: images.registryHost,
    username: robot.robotName,
    password: robot.secret,
  });
});

/** Where one fixture's image is pushed. */
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
 * The async form, with the handler in `async-function.ts`. This module also runs
 * inside the deployed hosts binding to it, where the path means nothing and
 * `import.meta.url` may not be a URL.
 */
export const Ping = Effect.gen(function* () {
  const puller = yield* Puller;
  const registry = yield* registryFor("ping");
  return yield* Stackit.Functions.Function("StackitFunctionsPing", {
    main: globalThis.__ALCHEMY_RUNTIME__
      ? "async-function.ts"
      : new URL("./async-function.ts", import.meta.url).href,
    registry,
    pullCredential: puller.pullCredentialId,
    env: { GREETING: "hello from async", SECRET: "not-a-secret" },
  });
});

export type PingEnv = Stackit.InferEnv<typeof Ping>;
