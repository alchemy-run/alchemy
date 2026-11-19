import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import EnvWebFunctionLive, { EnvWebFunction, webEnv } from "./fixtures/web/env-web.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const Stack = Alchemy.Stack(
  "AlchemyLambdaWebEnvStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const fn = yield* EnvWebFunction;
    return { url: fn.url };
  }).pipe(Effect.provide(EnvWebFunctionLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

test(
  "WebFunction reads every env value as the expected string",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const body = yield* HttpClient.get(url).pipe(
      Effect.timeout("10 seconds"),
      Effect.flatMap((res) =>
        res.status === 200 ? res.json : Effect.fail(new Error(`Request failed: ${res.status}`)),
      ),
      Effect.retry({ schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]) }),
    );
    expect(body).toEqual(webEnv.expected);
  }),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
);
