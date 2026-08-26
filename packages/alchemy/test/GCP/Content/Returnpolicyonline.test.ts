import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as content from "@distilled.cloud/gcp/content_v2_1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  merchantId,
  probeMerchantId,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (accountId: string, returnPolicyId: string) =>
  content.getReturnpolicyonline({ merchantId: accountId, returnPolicyId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getReturnpolicyonline on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getReturnpolicyonline({
          merchantId: probeMerchantId,
          returnPolicyId: "alchemy-missing-policy",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "createReturnpolicyonline without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.createReturnpolicyonline({
          merchantId: probeMerchantId,
          body: {
            name: "alchemy-probe",
            label: "default",
            countries: ["US"],
            policy: { type: "NO_RETURNS" },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a return policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Returnpolicyonline("NoReturns", {
            merchantId: merchantId!,
            name: "no-returns",
            label: "default",
            countries: ["US"],
            policy: { type: "NO_RETURNS" },
          });
        }),
      );

      expect(created.returnPolicyId.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.name).toEqual("no-returns");
      expect(created.policy?.type).toEqual("NO_RETURNS");

      const fetched = yield* content.getReturnpolicyonline({
        merchantId: created.merchantId,
        returnPolicyId: created.returnPolicyId,
      });
      expect(fetched.returnPolicyId).toEqual(created.returnPolicyId);
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Returnpolicyonline("NoReturns", {
            merchantId: created.merchantId,
            returnPolicyId: created.returnPolicyId,
            name: "no-returns-v2",
            label: "default",
            countries: ["US"],
            policy: { type: "NO_RETURNS" },
          });
        }),
      );

      expect(updated.returnPolicyId).toEqual(created.returnPolicyId);
      expect(updated.name).toEqual("no-returns-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.merchantId,
        created.returnPolicyId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
