import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * The registry the built images go to, and the environment and login every fixture
 * shares. A registry login isn't something STACKIT credentials provide, so the built forms
 * need `STACKIT_TEST_HARBOR_USERNAME` and `STACKIT_TEST_HARBOR_SECRET`.
 */
const identity = {
  username: Config.String("STACKIT_TEST_HARBOR_USERNAME"),
  secret: Config.Redacted("STACKIT_TEST_HARBOR_SECRET"),
};

/** The generated name is stable, so every run reuses this one environment. */
export const Apps = Stackit.ContainerApplications.Environment("StackitScaApps", {});

export const Images = Stackit.ContainerRegistry.Project("StackitScaImages", {
  forceDestroy: true,
  harborCredentials: identity,
});

export const Pusher = Effect.gen(function* () {
  const images = yield* Images;
  return yield* Stackit.ContainerRegistry.RobotAccount("StackitScaPusher", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
    ],
  });
});

/** The environment's login for the registry: its id is the applications' `environmentId`. */
export const PullLogin = Effect.gen(function* () {
  const apps = yield* Apps;
  const images = yield* Images;
  const robot = yield* Stackit.ContainerRegistry.RobotAccount("StackitScaPuller", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [{ resource: "repository", action: "pull" }],
  });
  return yield* Stackit.ContainerApplications.EnvironmentRegistry("StackitScaPullLogin", {
    environmentId: apps.environmentId,
    server: images.registryHost,
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
 * The async form, with the handler in `async-application.ts`. This module also runs inside
 * the deployed hosts binding to it, where the path means nothing and `import.meta.url` may
 * not be a URL.
 */
export const Ping = Effect.gen(function* () {
  const login = yield* PullLogin;
  const registry = yield* registryFor("ping");
  return yield* Stackit.ContainerApplications.Application("StackitScaPing", {
    environmentId: login.environmentId,
    main: globalThis.__ALCHEMY_RUNTIME__
      ? "async-application.ts"
      : new URL("./async-application.ts", import.meta.url).href,
    registry,
    env: { GREETING: "hello from async" },
  });
});

export type PingEnv = Stackit.InferEnv<typeof Ping>;
