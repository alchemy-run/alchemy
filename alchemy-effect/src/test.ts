import { FetchHttpClient, FileSystem, HttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as App from "./app.ts";
import { PlanStatusReporter } from "./apply.ts";
import { DotAlchemy, dotAlchemy } from "./dot-alchemy.ts";
import * as State from "./state.ts";

type Provided =
  | Scope.Scope
  | App.App
  | State.State
  | DotAlchemy
  | HttpClient.HttpClient
  | FileSystem.FileSystem;

export function test(
  name: string,
  testCase: Effect.Effect<void, any, Provided>,
  timeout: number = 120_000,
) {
  const appName = name.replaceAll(/[^a-zA-Z0-9_]/g, "-");
  const app = App.make({ name: appName, stage: "test" });

  const providers = Layer.provideMerge(
    Layer.mergeAll(State.localFs, report),
    Layer.mergeAll(app, dotAlchemy),
  );

  const layers = Layer.provideMerge(
    providers,
    Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer, Logger.pretty),
  );

  return it.scopedLive(
    name,
    () =>
      testCase.pipe(
        Effect.provide(layers),
        Logger.withMinimumLogLevel(LogLevel.Info),
      ),
    timeout,
  );
}

export const report = Layer.succeed(
  PlanStatusReporter,
  PlanStatusReporter.of({
    start: Effect.fn(function* (plan) {
      return {
        done: () => Effect.void,
        emit: (event) =>
          Effect.log(
            event.kind === "status-change"
              ? `${event.status} ${event.id}(${event.type})`
              : event.message,
          ),
      };
    }),
  }),
);
