import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Apply from "alchemy/Apply";
import * as AuthProviders from "alchemy/Auth/AuthProvider";
import * as Cli from "alchemy/Cli/Cli";
import * as Config from "alchemy/Config";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import * as Stage from "alchemy/Stage";
import * as State from "alchemy/State";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const services = Layer.provideMerge(
  Layer.mergeAll(
    Layer.succeed(Stage.Stage, "dev"),
    Layer.succeed(Stack.Stack, {
      name: "CloudflareWorker",
      stage: "dev",
      resources: {},
      bindings: {},
    }),
    Layer.succeed(AuthProviders.AuthProviders, {}),
    Config.dotAlchemy,
    FetchHttpClient.layer,
  ),
  PlatformServices,
);

const entry = (await import("./alchemy.run.ts")).default;

Effect.gen(function* () {
  const stack = yield* Stack.Stack;
  const compiledStack = {
    ...stack,
    output: yield* entry.effect,
  };
  console.log("[stack]", stack);

  const plan = yield* Plan.make(compiledStack);
  console.log("[plan]", plan);

  const output = yield* Apply.apply(plan);
  console.log("[output]", output);

  yield* Effect.never;
}).pipe(
  Effect.provide(State.LocalState),
  Effect.provide(entry.providers),
  Effect.provide(services),
  Effect.provideService(Cli.Cli, {
    approvePlan: () => Effect.succeed(true),
    displayPlan: () => Effect.void,
    startApplySession: () =>
      Effect.sync(() => {
        console.log("[apply] start");
        return {
          emit: ({ id, ...event }) =>
            Effect.sync(() => console.log(`[apply][${id}]`, { event })),
          done: () => Effect.sync(() => console.log("[apply] done")),
        };
      }),
  }),
  Effect.scoped,
  NodeRuntime.runMain,
);
