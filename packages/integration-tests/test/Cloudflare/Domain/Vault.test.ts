import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { caseNames } from "../../Domain/vault/cases.ts";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/vault-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
});

/** A cases route answered with something other than 200. */
class CasesRequestFailed extends Data.TaggedError("CasesRequestFailed")<{
  readonly status: number;
  readonly body: string;
}> {}

const passed = Object.fromEntries(caseNames.map((name) => [name, true]));

// A Vault's keys on Cloudflare: kept in Durable Objects or D1, wrapped under a Secrets Store secret.
describe(
  "Domain Vault on Cloudflare",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 420_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

    const cases = (pairing: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* requestWorker(
          HttpClientRequest.get(`${url.replace(/\/+$/, "")}/cases/${pairing}`),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.flatMap(res.text, (body) =>
                  Effect.fail(new CasesRequestFailed({ status: res.status, body })),
                ),
          ),
          // Right after a deploy the secret and the classes are still rolling out.
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
        );
      });

    test(
      "keys in Durable Objects, wrapped under a Secrets Store secret",
      Effect.gen(function* () {
        expect(yield* cases("host-secret")).toEqual(passed);
      }),
      { timeout: 120_000 },
    );
    test(
      "keys in D1, wrapped under a Secrets Store secret",
      Effect.gen(function* () {
        expect(yield* cases("d1-secret")).toEqual(passed);
      }),
      { timeout: 120_000 },
    );
    test(
      "keys in D1, unwrapped",
      Effect.gen(function* () {
        expect(yield* cases("d1-none")).toEqual(passed);
      }),
      { timeout: 120_000 },
    );
  },
);
