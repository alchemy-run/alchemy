import * as AWS from "@alchemy.run/aws";
import * as Daytona from "@alchemy.run/daytona";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import GatewayedDaytona from "./fixtures/daytona.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Daytona.providers(), E2B.providers(), AWS.providers()),
});

const get = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
    ),
    // The preview proxy takes a few seconds to warm up.
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
    Effect.map((served) => served as unknown as Served),
  );

test.provider(
  "a Daytona sandbox's bindings run in a gateway it reaches through Lambda Invoke",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(GatewayedDaytona);
      expectGatewayed(yield* get(sandbox.url!), { gatewayHost: "lambda." });
      yield* stack.destroy();
    }),
  {
    tags: ["provider:daytona", "provider:e2b", "provider:aws", "provider:aws:lambda", "live"],
    timeout: 900_000,
  },
);
