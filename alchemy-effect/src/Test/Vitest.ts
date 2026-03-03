import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import type * as aws from "distilled-aws";
import { Logger } from "effect";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodePath from "node:path";
import * as AWS from "../AWS/index.ts";

import { apply } from "../Apply.ts";
import * as Credentials from "../AWS/Credentials.ts";
import * as Region from "../AWS/Region.ts";
import type { Cli } from "../Cli/index.ts";
import { DotAlchemy, dotAlchemy } from "../Config.ts";
import { ExecutionContext } from "../Executable.ts";
import type { Input } from "../Input.ts";
import * as Plan from "../Plan.ts";
import * as Stack from "../Stack.ts";
import * as Stage from "../Stage.ts";
import * as State from "../State/index.ts";
import { TestCli } from "./TestCli.ts";

declare module "@effect/vitest" {
  interface ExpectStatic {
    emptyObject(): any;
    propExpr(identifier: string, src: any): any;
  }
}

expect.emptyObject = () =>
  expect.toSatisfy(
    (deletions) => Object.keys(deletions).length === 0,
    "empty object",
  );

expect.propExpr = (identifier: string, src: any) =>
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
  | Stack.Stack
  | State.State
  | Stage.Stage
  | DotAlchemy
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | aws.Credentials.Credentials
  | aws.Region.Region
  | Cli
  | ExecutionContext
  | AWS.StageConfig;

export function test(
  name: string,
  options: {
    timeout?: number;
    state?: Layer.Layer<State.State, never, Stack.Stack>;
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
          state?: Layer.Layer<State.State, never, Stack.Stack>;
        },
        Effect.Effect<void, any, Provided>,
      ]
    | [Effect.Effect<void, any, Provided>]
) {
  const [options = {}, testCase] =
    args.length === 1 ? [undefined, args[0]] : args;

  const testPath = expect.getState().testPath ?? "";
  const testDir = testPath.includes("/test/")
    ? (testPath.split("/test/").pop() ?? "")
    : NodePath.basename(testPath);
  const testPathWithoutExt = testDir.replace(/\.[^.]+$/, "");
  const stackName = `${testPathWithoutExt}-${name}`
    .replaceAll(/[^a-zA-Z0-9_]/g, "-")
    .replace(/-+/g, "-");

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );
  const aws = Layer.provideMerge(
    AWS.providers(),
    Layer.mergeAll(Credentials.fromStageConfig(), Region.fromStageConfig()),
  );

  const awsStageConfig = Layer.effect(
    AWS.StageConfig,
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

      return AWS.StageConfig.of({
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
      });
    }),
  );
  const stack = Layer.effect(
    Stack.Stack,
    Effect.succeed({
      name: stackName,
      stage: "test",
      resources: {},
      bindings: {},
    }),
  );

  const alchemy = Layer.provideMerge(
    Layer.mergeAll(options.state ?? State.LocalState, TestCli),
    Layer.mergeAll(awsStageConfig, stack, dotAlchemy),
  );

  const test = Effect.gen(function* () {
    const configProvider = ConfigProvider.orElse(
      yield* ConfigProvider.fromDotEnv({ path: ".env" }),
      ConfigProvider.fromEnv(),
    );
    return yield* testCase.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
    );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(aws, Layer.provideMerge(alchemy, platform)),
    ),
    Effect.provideService(Stage.Stage, "test"),
    Effect.provideService(ExecutionContext, {
      kind: "ExecutionContext",
      type: "function",
      listen: () => {
        return Effect.void;
      },
      get: <T>(key: string) => {
        return Effect.succeed<T>(undefined as T);
      },
    }),
    Effect.provideService(
      MinimumLogLevel,
      process.env.DEBUG ? "Debug" : "Info",
    ),
    Effect.provide(NodeServices.layer),
  );

  return it.live(name, () => test, options.timeout);
}

export namespace test {
  export function skip(
    name: string,
    options: {
      timeout?: number;
      state?: Layer.Layer<State.State, never, Stack.Stack>;
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
            state?: Layer.Layer<State.State, never, Stack.Stack>;
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
              state?: Layer.Layer<State.State, never, Stack.Stack>;
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
        const stack = yield* Stack.Stack;
        return State.InMemoryService({
          [stack.name]: {
            [stack.stage]: resources,
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
      State.InMemoryService({
        ["test-app"]: {
          ["test-stage"]: resources,
        },
        ...other,
      }),
    );

  export const deploy = <A, Err = never, Req = any>(
    effect: Effect.Effect<A, Err, Req>,
  ): Effect.Effect<Input.Resolve<A>, Err, Req | Stack.Stack> =>
    Stack.Stack.use((stack) =>
      effect.pipe(
        // @ts-expect-error
        Stack.make(stack.name),
        Effect.flatMap(Plan.make),
        Effect.flatMap(apply),
      ),
    );
}

export function skip(
  name: string,
  options: {
    timeout?: number;
    state?: Layer.Layer<State.State, never, Stack.Stack>;
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
          state?: Layer.Layer<State.State, never, Stack.Stack>;
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
            state?: Layer.Layer<State.State, never, Stack.Stack>;
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
