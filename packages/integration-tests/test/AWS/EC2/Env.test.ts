import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectedEnv, getJson, readEnvValues } from "../../EnvValues.ts";
import EnvInstance, { envContainerContext, envInstanceProps } from "./fixtures/env-instance.ts";
import * as Test from "./VpcTest.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Both modes in one stack, both reading one systemd `EnvironmentFile`: a
// program, and a `context` image passed each key with `docker run -e NAME`.

const Stack = Alchemy.Stack(
  "AlchemyEc2EnvStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const program = yield* EnvInstance;
    const container = yield* AWS.EC2.Instance("Ec2EnvContainer", {
      ...(yield* envInstanceProps),
      context: envContainerContext,
    });
    return { programUrl: program.url, containerUrl: container.url };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

// Polls until the instance boots and serves, then returns its echoed env.
const fetchEnv = (url: string) =>
  getJson(url, { times: 200 }).pipe(
    Effect.map((body) => readEnvValues(body as Record<string, string | undefined>)),
  );

test.skipIf(!!process.env.FAST)(
  "EC2 program and container instances read every env value as its string",
  Effect.gen(function* () {
    const { programUrl, containerUrl } = yield* stack;
    expect({
      program: yield* fetchEnv(programUrl!),
      container: yield* fetchEnv(containerUrl!),
    }).toEqual({ program: expectedEnv, container: expectedEnv });
  }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 900_000 },
);
