import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  advertiserProps,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (advertiserId: string, negativeKeywordListId: string) =>
  dv
    .getAdvertisersNegativeKeywordLists({
      advertiserId,
      negativeKeywordListId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersNegativeKeywordLists on a missing list fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersNegativeKeywordLists({
          advertiserId: "1",
          negativeKeywordListId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a negative keyword list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const list = yield* GCP.Displayvideo.AdvertisersNegativeKeywordList(
            "BrandExclusions",
            {
              advertiserId: advertiser.advertiserId,
              displayName: "brand-exclusions",
            },
          );
          return { advertiser, list };
        }),
      );

      expect(created.list.negativeKeywordListId).toEqual(expect.any(String));
      expect(created.list.advertiserId).toEqual(
        created.advertiser.advertiserId,
      );
      expect(created.list.displayName).toEqual("brand-exclusions");

      const fetched = yield* dv.getAdvertisersNegativeKeywordLists({
        advertiserId: created.list.advertiserId,
        negativeKeywordListId: created.list.negativeKeywordListId,
      });
      expect(fetched.negativeKeywordListId).toEqual(
        created.list.negativeKeywordListId,
      );
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const list = yield* GCP.Displayvideo.AdvertisersNegativeKeywordList(
            "BrandExclusions",
            {
              advertiserId: advertiser.advertiserId,
              negativeKeywordListId: created.list.negativeKeywordListId,
              displayName: "brand-exclusions-v2",
            },
          );
          return { advertiser, list };
        }),
      );

      expect(updated.list.negativeKeywordListId).toEqual(
        created.list.negativeKeywordListId,
      );
      expect(updated.list.displayName).toEqual("brand-exclusions-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.list.advertiserId,
        created.list.negativeKeywordListId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
