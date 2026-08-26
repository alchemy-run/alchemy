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

const targetMerchantId =
  process.env.GCP_CONTENT_TARGET_MERCHANT_ID?.trim() || merchantId;
const probeTargetMerchantId = targetMerchantId ?? "1";

const waitUntilGone = (
  providerId: string,
  targetId: string,
  storeCode: string,
) =>
  content
    .getPos({
      merchantId: providerId,
      targetMerchantId: targetId,
      storeCode,
    })
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
  "getPos on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getPos({
          merchantId: probeMerchantId,
          targetMerchantId: probeTargetMerchantId,
          storeCode: "alchemy-missing-store",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "insertPos without Merchant Center POS access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.insertPos({
          merchantId: probeMerchantId,
          targetMerchantId: probeTargetMerchantId,
          body: {
            storeCode: "alchemy-probe-store",
            storeName: "Alchemy Probe Store",
            storeAddress: "123 Main St, Springfield, IL 62701",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a POS store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Po("Downtown", {
            merchantId: merchantId!,
            targetMerchantId,
            storeAddress: "123 Main St, Springfield, IL 62701",
            storeName: "Downtown",
            phoneNumber: "+1-217-555-0100",
          });
        }),
      );

      expect(created.storeCode.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.storeName).toEqual("Downtown");
      expect(created.storeAddress).toContain("Springfield");

      const fetched = yield* content.getPos({
        merchantId: created.merchantId,
        targetMerchantId: created.targetMerchantId,
        storeCode: created.storeCode,
      });
      expect(fetched.storeCode).toEqual(created.storeCode);
      expect(fetched.storeName).toContain("[alchemy ");
      expect(fetched.storeName).toContain("Downtown");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Po("Downtown", {
            merchantId: created.merchantId,
            targetMerchantId: created.targetMerchantId,
            storeCode: created.storeCode,
            storeAddress: "123 Main St, Springfield, IL 62701",
            storeName: "Downtown flagship",
            phoneNumber: "+1-217-555-0199",
          });
        }),
      );

      expect(updated.storeCode).toEqual(created.storeCode);
      expect(updated.storeName).toEqual("Downtown flagship");
      expect(updated.phoneNumber).toEqual("+1-217-555-0199");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.merchantId,
        created.targetMerchantId,
        created.storeCode,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
