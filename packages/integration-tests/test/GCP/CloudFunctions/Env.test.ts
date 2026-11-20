import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectedEnv, getJson } from "../../EnvValues.ts";
import EnvFunction from "./fixtures/env-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: GCP.providers() });

const Stack = Alchemy.Stack(
  "GcpCloudFunctionsEnvStack",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* EnvFunction;
    // Let the test call the function without an identity token.
    yield* GCP.IAM.Member("PublicInvoker", {
      kind: "run.service",
      name: fn.service.as<string>(),
      role: "roles/run.invoker",
      member: "allUsers",
    });
    return { url: fn.url.as<string>() };
  }),
);

// Cloud Build + function provisioning is slow.
describe.skipIf(!!process.env.FAST)("env values", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

  test(
    "Cloud Functions deploys every env value as the string the process reads",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(yield* getJson(url)).toEqual(expectedEnv);
    }),
    { tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"], timeout: 120_000 },
  );
});
