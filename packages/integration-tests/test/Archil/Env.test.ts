import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedEnv, getJson } from "../EnvValues.ts";
import EnvApi from "./fixtures/program/env.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Archil.providers(),
});

const Stack = Alchemy.Stack(
  "ArchilEnvStack",
  { providers: Archil.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* EnvApi;
    return { url: api.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

test(
  "a sandbox program reads every env value as its string",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(url)).toEqual(expectedEnv);
  }),
  { tags: ["provider:archil", "provider:archil:sandbox", "live"], timeout: 90_000 },
);
