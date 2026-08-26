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

const waitUntilGone = (accountId: string, conversionSourceId: string) =>
  content
    .getConversionsources({ merchantId: accountId, conversionSourceId })
    .pipe(
      Effect.flatMap((source) =>
        source.state === "ARCHIVED"
          ? Effect.succeed("gone" as const)
          : Effect.succeed("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getConversionsources on a missing source fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getConversionsources({
          merchantId: probeMerchantId,
          conversionSourceId: "mcdn:alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "createConversionsources without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.createConversionsources({
          merchantId: probeMerchantId,
          body: {
            merchantCenterDestination: {
              displayName: "alchemy-probe",
              currencyCode: "USD",
              attributionSettings: {
                attributionLookbackWindowInDays: 30,
                attributionModel: "CROSS_CHANNEL_LAST_CLICK",
              },
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
  "create, update, and delete a conversion source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Conversionsource("Purchases", {
            merchantId: merchantId!,
            merchantCenterDestination: {
              displayName: "website-purchases",
              currencyCode: "USD",
              attributionSettings: {
                attributionLookbackWindowInDays: 30,
                attributionModel: "CROSS_CHANNEL_LAST_CLICK",
              },
            },
          });
        }),
      );

      expect(created.conversionSourceId.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.merchantCenterDestination?.displayName).toEqual(
        "website-purchases",
      );

      const fetched = yield* content.getConversionsources({
        merchantId: created.merchantId,
        conversionSourceId: created.conversionSourceId,
      });
      expect(fetched.conversionSourceId).toEqual(created.conversionSourceId);
      expect(fetched.merchantCenterDestination?.displayName).toContain(
        "[alchemy ",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Conversionsource("Purchases", {
            merchantId: created.merchantId,
            conversionSourceId: created.conversionSourceId,
            merchantCenterDestination: {
              displayName: "website-purchases-v2",
              currencyCode: "USD",
              attributionSettings: {
                attributionLookbackWindowInDays: 7,
                attributionModel: "CROSS_CHANNEL_LAST_CLICK",
              },
            },
          });
        }),
      );

      expect(updated.conversionSourceId).toEqual(created.conversionSourceId);
      expect(updated.merchantCenterDestination?.displayName).toEqual(
        "website-purchases-v2",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.merchantId,
        created.conversionSourceId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
