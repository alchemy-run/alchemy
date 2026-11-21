import * as Fly from "@alchemy.run/fly";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedBound, expectedEnv, getJson } from "../EnvValues.ts";
import EnvValuesApi from "./fixtures/env-values.ts";
import { flyApi } from "./limit.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  limit: flyApi,
  providers: Fly.providers(),
});

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

test(
  "Fly.Service deploys env values and bound Outputs as the process reads them",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(url)).toEqual({ env: expectedEnv, bound: expectedBound });
  }),
  { tags: ["provider:fly", "provider:fly:service", "live"], timeout: 90_000 },
);
