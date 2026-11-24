import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectedBound, expectedEnv, getJson } from "../../EnvValues.ts";
import { jsonStrings } from "../../JsonStrings.ts";
import EnvStringsFunctionLive, { EnvStringsFunction } from "./fixtures/env-handler.ts";
import EnvWebFunctionLive, { EnvWebFunction, webEnv } from "./fixtures/web/env-web.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Stack = Alchemy.Stack(
  "AlchemyLambdaEnvStringsStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const fn = yield* EnvStringsFunction;
    const web = yield* EnvWebFunction;
    return {
      url: fn.functionUrl.as<string>(),
      webUrl: web.url,
      functionName: fn.functionName.as<string>(),
      webFunctionName: web.functionName,
      webRevisionId: web.revisionId,
    };
  }).pipe(Effect.provide(EnvStringsFunctionLive), Effect.provide(EnvWebFunctionLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: 210_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 180_000 });

test(
  "Lambda reads env values as their strings, and JSON-looking ones unchanged (#2269, #2847, #3497)",
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
      values: expectedEnv,
      bound: expectedBound,
    });
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
);

test(
  "WebFunction reads every env value as its string",
  Effect.gen(function* () {
    const { webUrl } = yield* stack;
    expect(yield* getJson(webUrl)).toEqual({ values: webEnv.expected, bound: expectedBound });
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
);

/** A function's env, as deployed, with each value as its text. */
const plainText = (variables: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(variables ?? {}).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  ) as Record<string, unknown>;

/** The secrets are named, never held: `prefix` is the parameter's name or ARN. */
const expectSecretsNamed = (variables: Record<string, unknown>, prefix: string) => {
  // The `env` prop's `Redacted`s, and one bound in Construction.
  for (const key of ["ENV_SECRET", "ENV_SECRET_OBJECT", "ENV_BOUND_SECRET"]) {
    expect(variables[key]).toBeUndefined();
  }
  // Nor under another key: a bound secret is packed with a Redacted marker.
  const text = JSON.stringify(variables);
  expect(text).not.toContain("s3cret");
  expect(text).not.toContain("Redacted");
  // Plain values stay; secrets are one version-pinned SSM parameter.
  expect(variables.ENV_PLAIN).toBe("hello");
  expect(variables.ENV_BOUND_PLAIN).toBe("my-queue");
  expect(String(variables.ALCHEMY_SECRET_ENV)).toMatch(new RegExp(`^${prefix}:\\d+$`));
};

const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, { providers: AWS.providers() }, "AlchemyLambdaEnvStringsStack");

test(
  "a Lambda's configuration names its secret env values, never holds them (#3498)",
  Effect.gen(function* () {
    const { functionName } = yield* stack;
    const config = yield* aws(Lambda.getFunctionConfiguration({ FunctionName: functionName }));
    expectSecretsNamed(plainText(config.Environment?.Variables), `/alchemy/lambda/${functionName}`);
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
);

test(
  "a WebFunction's revision names its secret env values by ARN, never holds them",
  Effect.gen(function* () {
    const { webFunctionName, webRevisionId } = yield* stack;
    const revision = yield* aws(
      LambdaWeb.getWebFunctionRevision({
        functionName: webFunctionName,
        revisionId: webRevisionId,
      }),
    );
    expectSecretsNamed(
      plainText(revision.serviceConfig?.environmentVariables),
      `arn:aws:ssm:[a-z0-9-]+:\\d+:parameter/alchemy/lambda-web/${webFunctionName}`,
    );
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 90_000 },
);
