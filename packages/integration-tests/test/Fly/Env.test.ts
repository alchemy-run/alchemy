import * as Fly from "@alchemy.run/fly";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectedBound } from "../EnvBoundOutputs.ts";
import { getJson } from "../EnvHttp.ts";
import { expectedEnv } from "../EnvValues.ts";
import EnvValuesApi from "./fixtures/env-values.ts";
import { flyApi } from "./limit.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  limit: flyApi,
  providers: Fly.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Stack = Alchemy.Stack(
  "FlyEnvValuesFixture",
  { providers: Fly.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* EnvValuesApi;
    return { url: api.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

const tags = ["provider:fly", "provider:fly:service", "live"];

test(
  "Fly.Service deploys every env value as its process env string",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(`${url}/env`)).toEqual(expectedEnv);
  }).pipe(logLevel),
  { tags, timeout: 90_000 },
);

test(
  "Fly.Service reads back Outputs bound in init unchanged",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(`${url}/bound`)).toEqual(expectedBound);
  }).pipe(logLevel),
  { tags, timeout: 90_000 },
);
