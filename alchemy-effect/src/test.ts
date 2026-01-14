import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";

import type * as AWS from "distilled-aws";

import { FetchHttpClient, FileSystem, HttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Path from "@effect/platform/Path";
import * as PlatformConfigProvider from "@effect/platform/PlatformConfigProvider";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, LogLevel } from "effect";
import * as NodePath from "node:path";
import { App } from "./app.ts";
import { CLI } from "./cli/service.ts";
import { DotAlchemy, dotAlchemy } from "./dot-alchemy.ts";
import type { Resource } from "./resource.ts";
import * as State from "./state.ts";

import * as Credentials from "./aws/credentials.ts";
import * as Region from "./aws/region.ts";

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
  | App
  | State.State
  | DotAlchemy
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | AWS.Credentials.Credentials
  | AWS.Region.Region;

export function test(
  name: string,
  options: {
    timeout?: number;
    state?: Layer.Layer<State.State, never, App>;
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
          state?: Layer.Layer<State.State, never, App>;
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

  const aws = Layer.mergeAll(
    Credentials.fromStageConfig(),
    Region.fromStageConfig(),
  );

  const alchemy = Layer.provideMerge(
    Layer.mergeAll(options.state ?? State.localFs, testCLI),
    Layer.mergeAll(
      Layer.effect(
        App,
        Effect.gen(function* () {
          const AWS_PROFILE = yield* Config.string("AWS_PROFILE").pipe(
            Config.withDefault("default"),
          );

          const LOCAL = yield* Config.boolean("LOCAL").pipe(
            Config.withDefault(false),
          );

          const LOCALSTACK_ENDPOINT = yield* Config.string(
            "LOCALSTACK_ENDPOINT",
          ).pipe(Config.withDefault("http://localhost.localstack.cloud:4566"));

          // Include test file path to prevent state collisions between tests with the same name
          // Use the relative path from the test directory (e.g., "aws/s3/bucket.provider.test")
          const testPath = expect.getState().testPath ?? "";
          const testDir = testPath.includes("/test/")
            ? (testPath.split("/test/").pop() ?? "")
            : NodePath.basename(testPath);
          const testPathWithoutExt = testDir.replace(/\.[^.]+$/, "");
          const appName = `${testPathWithoutExt}-${name}`
            .replaceAll(/[^a-zA-Z0-9_]/g, "-")
            .replace(/-+/g, "-");

          return App.of({
            name: appName,
            stage: "test",
            config: {
              adopt: true,
              aws: {
                profile: LOCAL ? undefined : AWS_PROFILE,
                region: LOCAL ? "us-east-1" : undefined,
                credentials: LOCAL
                  ? {
                      accessKeyId: "test",
                      secretAccessKey: "test",
                      sessionToken: "test",
                    }
                  : undefined,
                endpoint: LOCAL
                  ? // use the default LOCALSTACK_ENDPOINT unless overridden
                    LOCALSTACK_ENDPOINT
                  : // if we tests are explicitly being run against a live AWS account, we don't need to use LocalStack
                    undefined,
              },
            },
          });
        }),
      ),
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
        Effect.provide(
          Layer.provideMerge(aws, Layer.provideMerge(alchemy, platform)),
        ),
        Logger.withMinimumLogLevel(
          process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
        ),
        Effect.provide(NodeContext.layer),
      ),
    options.timeout,
  );
}

export namespace test {
  export function skip(
    name: string,
    options: {
      timeout?: number;
      state?: Layer.Layer<State.State, never, App>;
    },
    testCase: Effect.Effect<void, any, Provided>,
  ): void;

  export function skip(
    name: string,
    testCase: Effect.Effect<void, any, Provided>,
  ): void;

  export function skip(
    name: string,
    ...args:
      | [
          {
            timeout?: number;
            state?: Layer.Layer<State.State, never, App>;
          },
          Effect.Effect<void, any, Provided>,
        ]
      | [Effect.Effect<void, any, Provided>]
  ) {
    const [options = {}, _testCase] =
      args.length === 1 ? [undefined, args[0]] : args;
    it.skip(name, () => {}, options.timeout);
  }

  export function skipIf(condition: boolean) {
    return function (
      name: string,
      ...args:
        | [
            {
              timeout?: number;
              state?: Layer.Layer<State.State, never, App>;
            },
            Effect.Effect<void, any, Provided>,
          ]
        | [Effect.Effect<void, any, Provided>]
    ) {
      if (condition) {
        const [options = {}, _testCase] =
          args.length === 1 ? [undefined, args[0]] : args;
        it.skip(name, () => {}, options.timeout);
      } else {
        test(name, ...(args as [Effect.Effect<void, any, Provided>]));
      }
    };
  }

  export const state = (resources: Record<string, State.ResourceState> = {}) =>
    Layer.effect(
      State.State,
      Effect.gen(function* () {
        const app = yield* App;
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
