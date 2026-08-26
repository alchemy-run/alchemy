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

const waitUntilGone = (advertiserId: string, creativeId: string) =>
  dv.getAdvertisersCreatives({ advertiserId, creativeId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersCreatives on a missing creative fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersCreatives({ advertiserId: "1", creativeId: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a creative",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const creative = yield* GCP.Displayvideo.AdvertisersCreative(
            "Banner",
            {
              advertiserId: advertiser.advertiserId,
              displayName: "example-banner",
              thirdPartyTag: "<ins></ins>",
              exitUrl: "https://example.com",
            },
          );
          return { advertiser, creative };
        }),
      );

      expect(created.creative.creativeId).toEqual(expect.any(String));
      expect(created.creative.displayName).toEqual("example-banner");
      expect(created.creative.hostingSource).toEqual(
        "HOSTING_SOURCE_THIRD_PARTY",
      );

      const fetched = yield* dv.getAdvertisersCreatives({
        advertiserId: created.creative.advertiserId,
        creativeId: created.creative.creativeId,
      });
      expect(fetched.creativeId).toEqual(created.creative.creativeId);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const creative = yield* GCP.Displayvideo.AdvertisersCreative(
            "Banner",
            {
              advertiserId: advertiser.advertiserId,
              creativeId: created.creative.creativeId,
              displayName: "example-banner-v2",
              entityStatus: "ENTITY_STATUS_PAUSED",
              thirdPartyTag: "<ins></ins>",
              exitUrl: "https://example.com/v2",
            },
          );
          return { advertiser, creative };
        }),
      );

      expect(updated.creative.creativeId).toEqual(created.creative.creativeId);
      expect(updated.creative.displayName).toEqual("example-banner-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.creative.advertiserId,
        created.creative.creativeId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
