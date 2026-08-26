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
  content.getProducts({ merchantId: accountId, productId }).pipe(
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
  "getProducts on a missing product fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getProducts({
          merchantId: probeMerchantId,
          productId: "online:en:US:alchemy-missing-product",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "insertProducts without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.insertProducts({
          merchantId: probeMerchantId,
          body: {
            offerId: "alchemy-probe-product",
            title: "Alchemy Probe Product",
            description: "probe",
            link: "https://example.com/probe",
            imageLink: "https://example.com/probe.jpg",
            availability: "in stock",
            condition: "new",
            channel: "online",
            contentLanguage: "en",
            targetCountry: "US",
            identifierExists: false,
            price: { currency: "USD", value: "1.00" },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Product("Tote", {
            merchantId: merchantId!,
            title: "Canvas tote",
            description: "carry-all",
            link: "https://example.com/tote",
            imageLink: "https://example.com/tote.jpg",
            price: { currency: "USD", value: "24.00" },
            identifierExists: false,
          });
        }),
      );

      expect(created.offerId.length).toBeGreaterThan(0);
      expect(created.productId.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.title).toEqual("Canvas tote");
      expect(created.description).toEqual("carry-all");
      expect(created.price?.value).toEqual("24.00");

      const fetched = yield* content.getProducts({
        merchantId: created.merchantId,
        productId: created.productId,
      });
      expect(fetched.id).toEqual(created.productId);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.title).toEqual("Canvas tote");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Product("Tote", {
            merchantId: created.merchantId,
            offerId: created.offerId,
            title: "Canvas tote large",
            description: "carry-all large",
            link: "https://example.com/tote",
            imageLink: "https://example.com/tote.jpg",
            price: { currency: "USD", value: "29.00" },
            identifierExists: false,
          });
        }),
      );

      expect(updated.productId).toEqual(created.productId);
      expect(updated.title).toEqual("Canvas tote large");
      expect(updated.description).toEqual("carry-all large");
      expect(updated.price?.value).toEqual("29.00");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.merchantId, created.productId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
