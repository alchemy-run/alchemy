import * as AWS from "@alchemy.run/aws";
import { describe } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import type { AwsServed } from "./conformance/aws-app.ts";
import { expectAwsGatewayed } from "./conformance/conformance.ts";
import MicrovmHost from "./fixtures/microvm/host.ts";
import GatewayedMicrovmLive from "./fixtures/microvm/sandbox.ts";

const testOptions = { providers: AWS.providers(), state: Alchemy.localState() };
const { test, beforeAll, afterAll, deploy, destroy } = Test.make(testOptions);

// MicroVM image builds run server-side and can take several minutes.
const HOOK_TIMEOUT = 1_500_000;

// Lambda MicroVM is a preview feature: the account must be onboarded to it.
const skip = !process.env.LAMBDA_TEST_MICROVM;

const Stack = Alchemy.Stack(
  "GatewayMicrovmStack",
  testOptions,
  Effect.gen(function* () {
    const host = yield* MicrovmHost;
    return { url: host.functionUrl.as<string>() };
  }).pipe(Effect.provide(GatewayedMicrovmLive)),
);

describe.skipIf(skip)(
  "a gatewayed Lambda MicroVM",
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "live"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: HOOK_TIMEOUT });

    test(
      "a Lambda MicroVM's S3 bindings run in a Lambda Web Function gateway",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        const served = yield* client.get(url).pipe(
          Effect.timeout("120 seconds"),
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.flatMap(res.text, (text) =>
                  Effect.fail(new Error(`${res.status}: ${text}`)),
                ),
          ),
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 5 }),
        );
        expectAwsGatewayed(served as unknown as AwsServed);
      }),
      { timeout: 900_000 },
    );
  },
);
