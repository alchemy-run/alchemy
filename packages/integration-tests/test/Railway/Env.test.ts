import * as Railway from "@alchemy.run/railway";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedBound, expectedEnv, getJson } from "../EnvValues.ts";
import EnvValuesApi from "./fixtures/env-values.ts";
import { railwayApi } from "./limit.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  limit: railwayApi,
  providers: Railway.providers(),
});

const Stack = Alchemy.Stack(
  "RailwayEnvValuesFixture",
  { providers: Railway.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* EnvValuesApi;
    return { url: api.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });

test(
  "Railway.Service deploys env values and bound Outputs as the process reads them",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(url)).toEqual({ env: expectedEnv, bound: expectedBound });
  }),
  { tags: ["provider:railway", "provider:railway:service", "live"], timeout: 90_000 },
);
