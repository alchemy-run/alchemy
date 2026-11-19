import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../../EnvValues.ts";
import EnvService from "./fixtures/env-service.ts";

// App Runner closed to new customers on 2026-04-30; accounts that weren't
// already customers get "Account <id> can't create new App Runner services".
// Set AWS_TEST_APPRUNNER_SERVICES=1 on an account that can still create them.
const skip = !!process.env.FAST || !process.env.AWS_TEST_APPRUNNER_SERVICES;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const Stack = Alchemy.Stack(
  "AlchemyAppRunnerEnvStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const service = yield* EnvService;
    return { serviceUrl: service.serviceUrl.as<string>() };
  }),
);

describe.skipIf(skip)("env values", () => {
  // Docker build + push + 3-5 min App Runner provisioning.
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

  test(
    "App Runner service reads every env value as the expected string",
    Effect.gen(function* () {
      const { serviceUrl } = yield* stack;
      const body = yield* HttpClient.get(`https://${serviceUrl}/env`).pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap((res) =>
          res.status === 200 ? res.json : Effect.fail(new Error(`Request failed: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
        }),
      );
      expect(body).toEqual(expectedEnv);
    }),
    { tags: ["provider:aws", "provider:aws:apprunner", "live"], timeout: 120_000 },
  );
});
