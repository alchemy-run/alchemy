import { FetchHttpClient, FileSystem, HttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Path from "@effect/platform/Path";
import * as PlatformConfigProvider from "@effect/platform/PlatformConfigProvider";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, LogLevel } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as App from "./app.ts";
import { CLI } from "./cli/service.ts";
import { DotAlchemy, dotAlchemy } from "./dot-alchemy.ts";
import type { Resource } from "./resource.ts";
import * as State from "./state.ts";

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
    state?: Layer.Layer<State.State, never, App.App>;
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
          state?: Layer.Layer<State.State, never, App.App>;
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
    Layer.mergeAll(options.state ?? State.localFs, testCLI),
    Layer.mergeAll(
      App.make({
        name: name.replaceAll(/[^a-zA-Z0-9_]/g, "-"),
        stage: "test",
        config: {
          adopt: true,
          aws: {
            profile: "default",
          },
        },
      }),
      dotAlchemy,
    ),
  );

  return it.scopedLive(
    name,
    () =>
      Effect.gen(function* () {
        const configProvider = ConfigProvider.orElse(
          yield* PlatformConfigProvider.fromDotEnv(".env"),
          ConfigProvider.fromEnv,
        );
        return yield* testCase.pipe(Effect.withConfigProvider(configProvider));
      }).pipe(
        Effect.provide(Layer.provideMerge(alchemy, platform)),
        Logger.withMinimumLogLevel(
          process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
        ),
        Effect.provide(NodeContext.layer),
        Effect.provide(NodeContext.layer),
      ),
    options.timeout,
  );
}

export namespace test {
  export const state = (resources: Record<string, State.ResourceState> = {}) =>
    Layer.effect(
      State.State,
      Effect.gen(function* () {
        const app = yield* App.App;
        return State.inMemoryService({
          [app.name]: {
            [app.stage]: resources,
          },
        });
      }),
    );

  export const defaultState = (
    resources: Record<string, State.ResourceState> = {},
    other?: {
      [stack: string]: {
        [stage: string]: {
          [resourceId: string]: State.ResourceState;
        };
      };
    },
  ) =>
    Layer.succeed(
      State.State,
      State.inMemoryService({
        ["test-app"]: {
          ["test-stage"]: resources,
        },
        ...other,
      }),
    );
}

export const testCLI = Layer.succeed(
  CLI,
  CLI.of({
    approvePlan: () => Effect.succeed(true),
    displayPlan: () => Effect.void,
    startApplySession: () =>
      Effect.succeed({
        done: () => Effect.void,
        emit: (event) =>
          Effect.log(
            event.kind === "status-change"
              ? `${event.status} ${event.id}(${event.type})`
              : `${event.id}: ${event.message}`,
          ),
      }),
  }),
);
