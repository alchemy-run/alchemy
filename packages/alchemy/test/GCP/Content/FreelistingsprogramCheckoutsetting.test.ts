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

const waitUntilGone = (accountId: string) =>
  content
    .getFreelistingsprogramCheckoutsettings({ merchantId: accountId })
    .pipe(
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
  "getFreelistingsprogramCheckoutsettings on a missing merchant fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getFreelistingsprogramCheckoutsettings({
          merchantId: probeMerchantId,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "insertFreelistingsprogramCheckoutsettings without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.insertFreelistingsprogramCheckoutsettings({
          merchantId: probeMerchantId,
          body: {
            uriSettings: {
              checkoutUriTemplate: "https://example.com/checkout?item_id={id}",
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete checkout settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.FreelistingsprogramCheckoutsetting(
            "Checkout",
            {
              merchantId: merchantId!,
              checkoutUriTemplate: "https://example.com/checkout?item_id={id}",
            },
          );
        }),
      );

      expect(created.merchantId).toEqual(merchantId);
      expect(created.checkoutUriTemplate).toContain("example.com/checkout");

      const fetched = yield* content.getFreelistingsprogramCheckoutsettings({
        merchantId: created.merchantId,
      });
      expect(fetched.uriSettings?.checkoutUriTemplate).toContain("alc=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.FreelistingsprogramCheckoutsetting(
            "Checkout",
            {
              merchantId: created.merchantId,
              checkoutUriTemplate:
                "https://example.com/checkout-v2?item_id={id}",
            },
          );
        }),
      );

      expect(updated.merchantId).toEqual(created.merchantId);
      expect(updated.checkoutUriTemplate).toContain("checkout-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.merchantId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
