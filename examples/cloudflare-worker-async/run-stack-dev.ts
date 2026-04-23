import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Apply from "alchemy/Apply";
import * as AuthProviders from "alchemy/Auth/AuthProvider";
import * as Cli from "alchemy/Cli/Cli";
import * as Config from "alchemy/Config";
import * as Plan from "alchemy/Plan";
import * as Stage from "alchemy/Stage";
import * as State from "alchemy/State";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const services = Layer.provideMerge(
  Layer.mergeAll(
    Layer.succeed(Stage.Stage, "dev"),
    Layer.succeed(AuthProviders.AuthProviders, {}),
    Config.dotAlchemy,
    FetchHttpClient.layer,
  ),
  PlatformServices,
);

Effect.gen(function* () {
  const output = yield* Effect.promise(() => import("./alchemy.run.ts")).pipe(
    Effect.flatMap((m) => m.default),
    Effect.flatMap((stack) => {
      console.log("[stack]", stack);
      return Plan.make(stack).pipe(
        Effect.flatMap((plan) => {
          console.log("[plan]", plan);
          return Apply.apply(plan);
        }),
        Effect.provide(stack.services),
      );
    }),
  );

  console.log("[output]", output);

  yield* Effect.never;
}).pipe(
  Effect.provide(State.LocalState),
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
