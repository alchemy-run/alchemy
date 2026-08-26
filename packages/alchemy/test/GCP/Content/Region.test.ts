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

const waitUntilGone = (accountId: string, regionId: string) =>
  content.getRegions({ merchantId: accountId, regionId }).pipe(
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
  "getRegions on a missing region fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getRegions({
          merchantId: probeMerchantId,
          regionId: "alchemy-missing-region",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "createRegions without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.createRegions({
          merchantId: probeMerchantId,
          regionId: "alchemy-probe-region",
          body: {
            displayName: "alchemy-probe",
            postalCodeArea: {
              regionCode: "US",
              postalCodes: [{ begin: "94000", end: "94199" }],
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
  "create, update, and delete a region",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Region("BayArea", {
            merchantId: merchantId!,
            displayName: "bay-area",
            postalCodeArea: {
              regionCode: "US",
              postalCodes: [{ begin: "94000", end: "94199" }],
            },
          });
        }),
      );

      expect(created.regionId.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.displayName).toEqual("bay-area");

      const fetched = yield* content.getRegions({
        merchantId: created.merchantId,
        regionId: created.regionId,
      });
      expect(fetched.regionId).toEqual(created.regionId);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Region("BayArea", {
            merchantId: created.merchantId,
            regionId: created.regionId,
            displayName: "bay-area-v2",
            postalCodeArea: {
              regionCode: "US",
              postalCodes: [{ begin: "94100", end: "94199" }],
            },
          });
        }),
      );

      expect(updated.regionId).toEqual(created.regionId);
      expect(updated.displayName).toEqual("bay-area-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.merchantId, created.regionId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
