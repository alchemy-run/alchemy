import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedEnv, getJson } from "../../EnvValues.ts";
import EnvService from "./fixtures/env-service.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: GCP.providers() });

const Stack = Alchemy.Stack(
  "GcpRunEnvStack",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const service = yield* EnvService;
    return { url: service.uri.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

test(
  "Cloud Run deploys every env value as the string the process reads",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(yield* getJson(url)).toEqual(expectedEnv);
  }),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 120_000 },
);
