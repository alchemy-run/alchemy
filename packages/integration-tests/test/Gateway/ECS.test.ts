import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import type { AwsServed } from "./conformance/aws-app.ts";
import { expectAwsGatewayed } from "./conformance/conformance.ts";
import EcsHost, { GatewayCapacity, GatewayCluster } from "./fixtures/ecs.ts";

const testOptions = { providers: AWS.providers(), state: Alchemy.localState() };
const { test, beforeAll, afterAll, deploy, destroy } = Test.make(testOptions);

// The deploy creates a NAT gateway, builds and pushes the sandbox image and
// attaches a Lambda Function to the VPC; destroy waits for the Function's
// network interfaces and the instances ECS launched to go.
const HOOK_TIMEOUT = 1_800_000;

const Stack = Alchemy.Stack(
  "GatewayEcsStack",
  testOptions,
  Effect.gen(function* () {
    yield* GatewayCluster;
    yield* GatewayCapacity;
    const host = yield* EcsHost;
    return { url: host.functionUrl.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: HOOK_TIMEOUT });

test.skipIf(!!process.env.FAST)(
  "an ECS Nitro sandbox's S3 bindings run in a Lambda Web Function gateway",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // The first sandbox on empty capacity waits for ECS to launch an
    // instance, which can outlast one request.
    const served = yield* client.get(url).pipe(
      // Under the 300 seconds at which Bun gives up on a response.
      Effect.timeout("295 seconds"),
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json
          : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
      ),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 4 }),
    );
    expectAwsGatewayed(served as unknown as AwsServed);
  }),
  {
    tags: ["provider:aws", "provider:aws:ecs", "provider:aws:lambda", "provider:aws:s3", "live"],
    timeout: 1_500_000,
  },
);
