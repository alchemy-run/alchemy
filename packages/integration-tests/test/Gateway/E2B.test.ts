import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import GatewayedE2B from "./fixtures/e2b.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(E2B.providers(), Cloudflare.providers()),
});

test.provider(
  "an E2B sandbox's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const template = yield* stack.deploy(GatewayedE2B);

      const served = yield* Effect.acquireUseRelease(
        sandboxes.createSandbox({ templateID: template.templateId, timeout: 300 }),
        (sandbox) =>
          Effect.gen(function* () {
            const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
            const token = sandbox.trafficAccessToken;
            const res = yield* client
              .get(`https://3000-${sandbox.sandboxID}.${sandbox.domain ?? "e2b.app"}/`, {
                headers: token
                  ? {
                      "e2b-traffic-access-token": Redacted.isRedacted(token)
                        ? Redacted.value(token)
                        : token,
                    }
                  : {},
              })
              .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
            return (yield* res.json) as unknown as Served;
          }),
        (sandbox) => Effect.ignore(sandboxes.deleteSandbox({ sandboxID: sandbox.sandboxID })),
      );
      expectGatewayed(served, { gatewayHost: "workers.dev" });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:e2b", "provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 900_000,
  },
);
