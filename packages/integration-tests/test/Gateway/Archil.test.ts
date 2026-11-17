import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import GatewayedArchil from "./fixtures/archil.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Archil.providers(), E2B.providers(), Cloudflare.providers()),
});

test.provider(
  "an Archil sandbox's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(GatewayedArchil);

      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const served = yield* client.get(`${sandbox.url}/`).pipe(
        Effect.flatMap((res) => res.json),
        // A fresh hostname or a waking sandbox can take a few seconds.
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
      );
      expectGatewayed(served as unknown as Served, { gatewayHost: "workers.dev" });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:archil", "provider:e2b", "provider:cloudflare", "live"],
    timeout: 600_000,
  },
);
