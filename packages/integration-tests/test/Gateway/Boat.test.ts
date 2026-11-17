import * as AWS from "@alchemy.run/aws";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import WebGatewayedBoat from "./fixtures/boat-web-function.ts";
import GatewayedBoat from "./fixtures/boat.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    Boat.providers(),
    E2B.providers(),
    Cloudflare.providers(),
    AWS.providers(),
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
