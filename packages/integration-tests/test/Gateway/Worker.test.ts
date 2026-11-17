import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import GatewayedWorker from "./fixtures/worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), E2B.providers()),
});

test.provider(
  "a Worker's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(GatewayedWorker);

      const client = yield* HttpClient.HttpClient;
      const served = yield* client.get(worker.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        // A fresh workers.dev url takes a few seconds to serve.
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
      );
      expectGatewayed(served as unknown as Served, { gatewayHost: "workers.dev" });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "provider:e2b", "live"],
    timeout: 600_000,
  },
);
