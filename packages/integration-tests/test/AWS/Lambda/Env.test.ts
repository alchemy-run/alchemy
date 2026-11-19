import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../../EnvValues.ts";
import { jsonStrings } from "../../JsonStrings.ts";
import EnvStringsFunctionLive, { EnvStringsFunction } from "./fixtures/env-handler.ts";
import EnvValuesFunctionLive, { EnvValuesFunction } from "./fixtures/env-values-handler.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Stack = Alchemy.Stack(
  "AlchemyLambdaEnvStringsStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const fn = yield* EnvStringsFunction;
    return { url: fn.functionUrl.as<string>() };
  }).pipe(Effect.provide(EnvStringsFunctionLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: 210_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

test(
  "Lambda reads env strings that parse as JSON unchanged (#2269, #2847, #3497)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const body = yield* HttpClient.get(url).pipe(
      Effect.timeout("10 seconds"),
      Effect.flatMap((res) =>
        res.status === 200 ? res.json : Effect.fail(new Error(`Request failed: ${res.status}`)),
      ),
      Effect.retry({ schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]) }),
    );
    expect(body).toEqual({
      init: { ...jsonStrings, JSON_FALSE_BOOL: false, JSON_NUM_NUMBER: 42 },
      runtime: { ...jsonStrings, JSON_FALSE_BOOL: false, JSON_NUM_NUMBER: 42 },
      env: jsonStrings,
    });
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
);

const ValuesStack = Alchemy.Stack(
  "AlchemyLambdaEnvValuesStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const fn = yield* EnvValuesFunction;
    return { url: fn.functionUrl.as<string>() };
  }).pipe(Effect.provide(EnvValuesFunctionLive)),
);

describe("env values", () => {
  const values = beforeAll(deploy(ValuesStack), { timeout: 210_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ValuesStack), { timeout: 180_000 });

  test(
    "Lambda reads every env value as the expected string",
    Effect.gen(function* () {
      const { url } = yield* values;
      const body = yield* HttpClient.get(url).pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap((res) =>
          res.status === 200 ? res.json : Effect.fail(new Error(`Request failed: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
        }),
      );
      expect(body).toEqual(expectedEnv);
    }).pipe(logLevel),
    { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
  );
});
