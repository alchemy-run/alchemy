import bun from "bun:test";
import { ConfigProvider } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HookOptions } from "node:test";
import { AlchemyContext, AlchemyContextLive } from "../AlchemyContext.ts";
import { provideFreshArtifactStore } from "../Artifacts.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { deploy as _deploy } from "../Deploy.ts";
import { destroy as _destroy } from "../Destroy.ts";
import {
  type CompiledStack,
  type StackEffect,
  type StackServices,
} from "../Stack.ts";
import * as State from "../State/index.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";

export type ProvidedServices = StackServices;

type TestEffect<A, Req = never> = StackEffect<A, any, Req>;

const platform = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

// override alchemy state store, CLI/reporting, state, and dotAlchemy
const alchemy = Layer.mergeAll(
  // CLI.inkCLI(),
  // optional
  Logger.layer([Logger.consolePretty()]),
  AlchemyContextLive,
);

const run = <A>(effect: TestEffect<A>) =>
  Effect.gen(function* () {
    const configProvider = yield* loadConfigProvider(Option.none());

    return yield* effect.pipe(
      provideFreshArtifactStore,
      Effect.provide(Layer.succeed(ConfigProvider, configProvider)),
    );
  }).pipe(
    Effect.provideService(AuthProviders, {}),
    Effect.provide(State.localState()),
    Effect.provide(Layer.provideMerge(alchemy, platform)),
    Effect.scoped,
    Effect.runPromise,
  );

export const it = test;

export const expect = bun.expect;

export function test(
  name: string,
  test: TestEffect<void>,
  options?: bun.TestOptions,
) {
  bun.test(name, () => run(test), options);
}

export namespace test {
  export function skipIf(condition: boolean) {
    return (
      name: string,
      test: TestEffect<void>,
      options?: bun.TestOptions,
    ) => {
      bun.test.skipIf(condition)(name, () => run(test), options);
    };
  }

  export function skip(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.skip(name, () => run(test), options);
  }

  export function only(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.only(name, () => run(test), options);
  }

  export function todo(
    name: string,
    test: TestEffect<void>,
    options?: bun.TestOptions,
  ) {
    bun.test.todo(name, () => run(test), options);
  }
}

export const describe = bun.describe;

export function beforeAll<A>(eff: TestEffect<A>, options?: HookOptions) {
  let a: A;
  bun.beforeAll(
    () => run(eff).then((v) => (a = v)),
    options ?? {
      timeout: 120_000,
    },
  );
  return Effect.sync(() => a);
}

export function beforeEach(eff: TestEffect<void>, options?: HookOptions) {
  bun.beforeEach(() => run(eff), options);
}

export function afterAll(eff: TestEffect<any>, options?: HookOptions) {
  bun.afterAll(() => run(eff), options);
}

export namespace afterAll {
  export const skipIf =
    (predicate: boolean) => (test: TestEffect<void>, options?: HookOptions) => {
      if (predicate) {
      } else {
        bun.afterAll(
          () => run(test),
          options ?? {
            timeout: 120_000,
          },
        );
      }
    };
}

export function afterEach(eff: TestEffect<void>, options?: HookOptions) {
  bun.afterEach(() => run(eff), options);
}

export const deploy = <A>(
  stack: TestEffect<CompiledStack<A>, AlchemyContext>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  _deploy({
    stack: stack,
    stage: options?.stage ?? "test",
  });

export const destroy = (
  stack: TestEffect<CompiledStack, AlchemyContext>,
  options?: {
    /** @default test */
    stage?: string;
  },
) =>
  _destroy({
    stack,
    stage: options?.stage ?? "test",
  });
