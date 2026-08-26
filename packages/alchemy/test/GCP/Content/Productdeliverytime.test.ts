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

const waitUntilGone = (accountId: string, productId: string) =>
  content.getProductdeliverytime({ merchantId: accountId, productId }).pipe(
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
  "getProductdeliverytime on a missing product fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getProductdeliverytime({
          merchantId: probeMerchantId,
          productId: "online:en:US:alchemy-missing-pdt",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "createProductdeliverytime without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.createProductdeliverytime({
          merchantId: probeMerchantId,
          body: {
            productId: { productId: "online:en:US:alchemy-probe-pdt" },
            areaDeliveryTimes: [
              {
                deliveryArea: { countryCode: "US" },
                deliveryTime: {
                  minHandlingTimeDays: 1,
                  maxHandlingTimeDays: 2,
                  minTransitTimeDays: 3,
                  maxTransitTimeDays: 5,
                },
              },
            ],
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete product delivery time",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Content.Product("Tote", {
            merchantId: merchantId!,
            title: "Canvas tote",
            description: "carry-all",
            link: "https://example.com/tote",
            imageLink: "https://example.com/tote.jpg",
            price: { currency: "USD", value: "24.00" },
            identifierExists: false,
          });
          const pdt = yield* GCP.Content.Productdeliverytime("SkuShip", {
            merchantId: product.merchantId,
            productId: product.productId,
            areaDeliveryTimes: [
              {
                deliveryArea: { countryCode: "US" },
                deliveryTime: {
                  minHandlingTimeDays: 1,
                  maxHandlingTimeDays: 2,
                  minTransitTimeDays: 3,
                  maxTransitTimeDays: 5,
                },
              },
            ],
          });
          return { product, pdt };
        }),
      );

      expect(created.pdt.productId).toEqual(created.product.productId);
      expect(
        created.pdt.areaDeliveryTimes[0]?.deliveryTime?.minHandlingTimeDays,
      ).toEqual(1);

      const fetched = yield* content.getProductdeliverytime({
        merchantId: created.pdt.merchantId,
        productId: created.pdt.productId,
      });
      expect(fetched.productId?.productId).toEqual(created.pdt.productId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Content.Product("Tote", {
            merchantId: created.product.merchantId,
            offerId: created.product.offerId,
            title: "Canvas tote",
            description: "carry-all",
            link: "https://example.com/tote",
            imageLink: "https://example.com/tote.jpg",
            price: { currency: "USD", value: "24.00" },
            identifierExists: false,
          });
          const pdt = yield* GCP.Content.Productdeliverytime("SkuShip", {
            merchantId: product.merchantId,
            productId: product.productId,
            areaDeliveryTimes: [
              {
                deliveryArea: { countryCode: "US" },
                deliveryTime: {
                  minHandlingTimeDays: 2,
                  maxHandlingTimeDays: 4,
                  minTransitTimeDays: 4,
                  maxTransitTimeDays: 7,
                },
              },
            ],
          });
          return { product, pdt };
        }),
      );

      expect(updated.pdt.productId).toEqual(created.pdt.productId);
      expect(
        updated.pdt.areaDeliveryTimes[0]?.deliveryTime?.minHandlingTimeDays,
      ).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.pdt.merchantId,
        created.pdt.productId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
