import { AlchemyContext } from "@/AlchemyContext.ts";
import {
  fromEnv,
  layer,
  RPC_SERVER_ENVIRONMENT_KEY,
  type RpcServerEnvironment,
} from "@/Local/RpcServerEnvironment.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const sampleEnv: RpcServerEnvironment = {
  profile: undefined,
  envFile: undefined,
  alchemyContext: {
    dotAlchemy: "/tmp/.alchemy",
    updateStateStore: false,
    dev: true,
    adopt: false,
  },
  stack: {
    name: "my-stack",
    stage: "dev",
  },
};

describe("Local.RpcServerEnvironment", () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env[RPC_SERVER_ENVIRONMENT_KEY];
  });

  afterEach(() => {
    if (prior === undefined) {
      delete process.env[RPC_SERVER_ENVIRONMENT_KEY];
    } else {
      process.env[RPC_SERVER_ENVIRONMENT_KEY] = prior;
    }
  });

  it.effect("layer() provides Stack, Stage, and AlchemyContext", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const stage = yield* Stage;
        const ctx = yield* AlchemyContext;
        return { stack, stage, ctx };
      }).pipe(
        Effect.provide(Layer.provide(layer(sampleEnv), PlatformServices)),
      );

      expect(observed.stack.name).toBe("my-stack");
      expect(observed.stack.stage).toBe("dev");
      expect(observed.stage).toBe("dev");
      expect(observed.ctx.dotAlchemy).toBe("/tmp/.alchemy");
      expect(observed.ctx.dev).toBe(true);
    }),
  );

  it("fromEnv() with a valid env var builds a usable layer", () => {
    process.env[RPC_SERVER_ENVIRONMENT_KEY] = JSON.stringify(sampleEnv);
    expect(() => fromEnv()).not.toThrow();
  });

  it("fromEnv() throws a descriptive Error when the env var is missing", () => {
    delete process.env[RPC_SERVER_ENVIRONMENT_KEY];
    expect(() => fromEnv()).toThrowError(
      new RegExp(
        `Failed to parse ${RPC_SERVER_ENVIRONMENT_KEY} environment variable`,
      ),
    );
  });

  it("fromEnv() throws and preserves the cause when the JSON is malformed", () => {
    process.env[RPC_SERVER_ENVIRONMENT_KEY] = "not-json";
    let caught: unknown;
    try {
      fromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { cause?: unknown }).cause).toBeDefined();
  });
});
