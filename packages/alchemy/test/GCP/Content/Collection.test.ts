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

const waitUntilGone = (accountId: string, collectionId: string) =>
  content.getCollections({ merchantId: accountId, collectionId }).pipe(
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
  "getCollections on a missing collection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.getCollections({
          merchantId: probeMerchantId,
          collectionId: "alchemy-missing-collection",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CONTENT)(
  "createCollections without Merchant Center access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        content.createCollections({
          merchantId: probeMerchantId,
          body: {
            id: "alchemy-probe-collection",
            headline: ["Alchemy Probe Collection"],
            language: "en",
            productCountry: "US",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a collection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Collection("Summer", {
            merchantId: merchantId!,
            headline: ["Summer picks"],
            link: "https://example.com/summer",
            language: "en",
            productCountry: "US",
          });
        }),
      );

      expect(created.collectionId.length).toBeGreaterThan(0);
      expect(created.merchantId).toEqual(merchantId);
      expect(created.headline?.[0]).toEqual("Summer picks");

      const fetched = yield* content.getCollections({
        merchantId: created.merchantId,
        collectionId: created.collectionId,
      });
      expect(fetched.id).toEqual(created.collectionId);
      expect(fetched.headline?.[0]).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Content.Collection("Summer", {
            merchantId: created.merchantId,
            collectionId: created.collectionId,
            headline: ["Summer picks v2"],
            link: "https://example.com/summer-v2",
            language: "en",
            productCountry: "US",
          });
        }),
      );

      expect(updated.collectionId).toEqual(created.collectionId);
      expect(updated.headline?.[0]).toEqual("Summer picks v2");
      expect(updated.link).toEqual("https://example.com/summer-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.merchantId,
        created.collectionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
