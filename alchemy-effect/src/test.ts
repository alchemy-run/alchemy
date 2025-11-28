import { FetchHttpClient, FileSystem, HttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import type * as Path from "@effect/platform/Path";
import { it, type Vitest, expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as App from "./app.ts";
import { PlanStatusReporter } from "./apply.ts";
import { DotAlchemy, dotAlchemy } from "./dot-alchemy.ts";
import * as State from "./state.ts";
import type { Resource } from "./resource.ts";

declare module "@effect/vitest" {
  interface ExpectStatic {
    emptyObject(): any;
    propExpr(identifier: string, src: Resource): any;
  }
}

expect.emptyObject = () =>
  expect.toSatisfy(
    (deletions) => Object.keys(deletions).length === 0,
    "empty object",
  );

expect.propExpr = (identifier: string, src: Resource) =>
  expect.objectContaining({
    kind: "PropExpr",
    identifier,
    expr: expect.objectContaining({
      kind: "ResourceExpr",
      src,
    }),
  });

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
  options: {
    timeout?: number;
    state?: Layer.Layer<State.State, never, never>;
  },
  testCase: Effect.Effect<void, any, Provided>,
): void;

export function test(
  name: string,
  testCase: Effect.Effect<void, any, Provided>,
): void;

export function test(
  name: string,
  ...args:
    | [
        {
          timeout?: number;
          state?: Layer.Layer<State.State, never, never>;
        },
        Effect.Effect<void, any, Provided>,
      ]
    | [Effect.Effect<void, any, Provided>]
) {
  const [options = {}, testCase] =
    args.length === 1 ? [undefined, args[0]] : args;
  const platform = Layer.mergeAll(
    NodeContext.layer,
    FetchHttpClient.layer,
    Logger.pretty,
  );

  const alchemy = Layer.provideMerge(
    Layer.mergeAll(options.state ?? State.localFs, report),
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
    options.timeout,
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
