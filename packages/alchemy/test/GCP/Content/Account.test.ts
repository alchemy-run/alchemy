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

const waitUntilGone = (parentId: string, accountId: string) =>
  content.getAccounts({ merchantId: parentId, accountId }).pipe(
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
  "getAccounts on a missing account fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getAccounts({
          merchantId: probeMerchantId,
          accountId: "1",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "insertAccounts without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.insertAccounts({
          merchantId: probeMerchantId,
          body: { name: "Alchemy Probe Account" },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sub-account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Account("Store", {
            merchantId: merchantId!,
            name: "downtown-store",
            websiteUrl: "https://example.com",
          });
        }),
      );

      expect(created.accountId.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.name).toEqual("downtown-store");

      const fetched = yield* content.getAccounts({
        merchantId: created.merchantId,
        accountId: created.accountId,
      });
      expect(fetched.id).toEqual(created.accountId);
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Account("Store", {
            merchantId: created.merchantId,
            accountId: created.accountId,
            name: "downtown-store-v2",
            websiteUrl: "https://example.com/v2",
          });
        }),
      );

      expect(updated.accountId).toEqual(created.accountId);
      expect(updated.name).toEqual("downtown-store-v2");
      expect(updated.websiteUrl).toEqual("https://example.com/v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.merchantId, created.accountId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
