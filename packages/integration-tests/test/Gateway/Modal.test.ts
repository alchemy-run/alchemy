import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Modal from "@alchemy.run/modal";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { hostIdentity } from "../Modal/hostIdentity.ts";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import ModalHost from "./fixtures/modal.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    Modal.providers(),
    E2B.providers(),
    Cloudflare.providers(),
    hostIdentity,
  ),
});

test.provider(
  "a Modal sandbox's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const host = yield* stack.deploy(ModalHost);

      const served = yield* HttpClient.get(host.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 5 }),
      );
      expectGatewayed(served as unknown as Served, { gatewayHost: "workers.dev" });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:modal", "provider:e2b", "provider:cloudflare", "live"],
    timeout: 900_000,
  },
);
