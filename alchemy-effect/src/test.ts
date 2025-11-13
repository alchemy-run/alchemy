import { FetchHttpClient, FileSystem, HttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import type * as Path from "@effect/platform/Path";
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
  | FileSystem.FileSystem
  | Path.Path;

export function test(
  name: string,
  testCase: Effect.Effect<void, any, Provided>,
  timeout: number = 120_000,
) {
  const platform = Layer.mergeAll(
    NodeContext.layer,
    FetchHttpClient.layer,
    Logger.pretty,
  );

  const alchemy = Layer.provideMerge(
    Layer.mergeAll(State.localFs, report),
    Layer.mergeAll(
      App.make({ name: name.replaceAll(/[^a-zA-Z0-9_]/g, "-"), stage: "test" }),
      dotAlchemy,
    ),
  );

  return it.scopedLive(
    name,
    () =>
      testCase.pipe(
        Effect.provide(Layer.provideMerge(alchemy, platform)),
        Logger.withMinimumLogLevel(
          process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
        ),
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
