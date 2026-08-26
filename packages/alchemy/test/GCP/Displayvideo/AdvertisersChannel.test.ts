import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  advertiserProps,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisersChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersChannels({
          advertiserId: "1",
          channelId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an advertiser channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const channel = yield* GCP.Displayvideo.AdvertisersChannel(
            "Premium",
            {
              advertiserId: advertiser.advertiserId,
              displayName: "premium-sites",
            },
          );
          return { advertiser, channel };
        }),
      );

      expect(created.channel.channelId).toEqual(expect.any(String));
      expect(created.channel.advertiserId).toEqual(
        created.advertiser.advertiserId,
      );
      expect(created.channel.displayName).toEqual("premium-sites");

      const fetched = yield* dv.getAdvertisersChannels({
        advertiserId: created.channel.advertiserId,
        channelId: created.channel.channelId,
      });
      expect(fetched.channelId).toEqual(created.channel.channelId);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiser.advertiserId,
          });
          const channel = yield* GCP.Displayvideo.AdvertisersChannel(
            "Premium",
            {
              advertiserId: advertiser.advertiserId,
              channelId: created.channel.channelId,
              displayName: "premium-sites-v2",
            },
          );
          return { advertiser, channel };
        }),
      );

      expect(updated.channel.channelId).toEqual(created.channel.channelId);
      expect(updated.channel.displayName).toEqual("premium-sites-v2");

      yield* stack.destroy();

      // DV360 has no Channels.delete — destroy strips the ownership prefix.
      const leftover = yield* dv.getAdvertisersChannels({
        advertiserId: created.channel.advertiserId,
        channelId: created.channel.channelId,
      });
      expect(leftover.displayName ?? "").not.toContain("alchemy-id=");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
