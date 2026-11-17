import * as AWS from "@alchemy.run/aws";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Fly from "@alchemy.run/fly";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import type { AwsServed } from "./conformance/aws-app.ts";
import { expectAwsGatewayed, expectGatewayed } from "./conformance/conformance.ts";
import AwsGatewayedBoat from "./fixtures/boat-aws.ts";
import EcsGatewayedBoat from "./fixtures/boat-ecs-service.ts";
import FlyGatewayedBoat from "./fixtures/boat-fly.ts";
import WebGatewayedBoat from "./fixtures/boat-web-function.ts";
import GatewayedBoat from "./fixtures/boat.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    Boat.providers(),
    E2B.providers(),
    Cloudflare.providers(),
    AWS.providers(),
    Fly.providers(),
  ),
});

/** GET the program with its port token, retrying while the port warms up. */
const ask = (sandbox: { url?: string; urlToken?: Redacted.Redacted<string> }) =>
  HttpClient.execute(
    HttpClientRequest.get(sandbox.url!).pipe(
      sandbox.urlToken === undefined
        ? (request) => request
        : HttpClientRequest.setHeader("cookie", `_port_auth=${Redacted.value(sandbox.urlToken)}`),
    ),
  ).pipe(
    Effect.timeout("60 seconds"),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
    Effect.map((served) => served as unknown as Served),
  );

test.provider(
  "a Boat sandbox's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(GatewayedBoat);
      expectGatewayed(yield* ask(sandbox), { gatewayHost: "workers.dev" });
      yield* stack.destroy();
    }),
  {
    tags: ["provider:boat", "provider:e2b", "provider:cloudflare", "live"],
    timeout: 600_000,
  },
);

test.provider(
  "a Boat sandbox's bindings run in a Lambda Web Function gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(WebGatewayedBoat);
      expectGatewayed(yield* ask(sandbox), { gatewayHost: ".on.aws" });
      yield* stack.destroy();
    }),
  {
    tags: ["provider:boat", "provider:e2b", "provider:aws", "provider:aws:lambda", "live"],
    timeout: 900_000,
  },
);

test.provider(
  "a Boat sandbox's S3 bindings run on its gateway's role, with no AWS key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(AwsGatewayedBoat);
      expectAwsGatewayed((yield* ask(sandbox)) as unknown as AwsServed);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:boat", "provider:aws", "provider:aws:lambda", "provider:aws:s3", "live"],
    timeout: 900_000,
  },
);

test.provider(
  "a Boat sandbox's bindings run in a Fly Service gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(FlyGatewayedBoat);
      expectGatewayed(yield* ask(sandbox), { gatewayHost: ".fly.dev" });
      yield* stack.destroy();
    }),
  {
    tags: ["provider:boat", "provider:e2b", "provider:fly", "live"],
    timeout: 900_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "a Boat sandbox's S3 bindings run in an ECS Service gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(EcsGatewayedBoat);
      const served = (yield* ask(sandbox)) as unknown as AwsServed;
      expect(served.body).toBe("written through the gateway");
      expect(served.streamed).toBe(1024 * 1024);
      expect(served.downloaded).toBe("written through the gateway");
      expect(served.direct).not.toBe("allowed");
      // The Service's load balancer, which has no domain here.
      expect(served.gateway).toContain(".elb.amazonaws.com");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:boat", "provider:aws", "provider:aws:ecs", "provider:aws:s3", "live"],
    timeout: 1_500_000,
  },
);
