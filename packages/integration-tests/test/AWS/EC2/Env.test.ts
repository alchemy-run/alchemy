import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { envValuesWithout, expectedEnv, readEnvValues } from "../../EnvValues.ts";
import EnvInstance, { envContainerContext, envInstanceProps } from "./fixtures/env-instance.ts";
import * as Test from "./VpcTest.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Both modes in one stack: the systemd `EnvironmentFile` program and a
// `context` image run with `docker run --env-file`. A Docker env file can't
// hold a newline (the deploy fails on one), so the container skips it.
const containerEnv = envValuesWithout("ENV_MULTILINE");

const Stack = Alchemy.Stack(
  "AlchemyEc2EnvStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const program = yield* EnvInstance;
    const container = yield* AWS.EC2.Instance("Ec2EnvContainer", {
      ...(yield* envInstanceProps),
      context: envContainerContext,
      env: containerEnv.values,
    });
    return {
      programUrl: program.url,
      programId: program.instanceId,
      containerUrl: container.url,
      containerId: container.instanceId,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

// Polls until the instance boots and serves, then returns its echoed env.
const fetchEnv = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("10 seconds"),
    Effect.flatMap((res) =>
      res.status === 200 ? res.json : Effect.fail(new Error(`Request failed: ${res.status}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("8 seconds"), times: 75 }),
    Effect.map((body) => readEnvValues(body as Record<string, string | undefined>)),
  );

test.skipIf(!!process.env.FAST)(
  "EC2 hosted program reads every env value as its string",
  Effect.gen(function* () {
    const { programUrl } = yield* stack;
    expect(yield* fetchEnv(programUrl!)).toEqual(expectedEnv);
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 720_000 },
);

test.skipIf(!!process.env.FAST)(
  "EC2 container instance reads every env value as its string",
  Effect.gen(function* () {
    const { containerUrl } = yield* stack;
    expect(yield* fetchEnv(containerUrl!)).toEqual(containerEnv.expected);
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 720_000 },
);
