import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { hasGcpCreds, logLevel, partnerId, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getPartnersChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getPartnersChannels({
          partnerId: "1",
          channelId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a partner channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Displayvideo.PartnersChannel("Premium", {
            partnerId,
            displayName: "premium-sites",
          });
        }),
      );

      expect(created.channelId).toEqual(expect.any(String));
      expect(created.partnerId).toEqual(partnerId);
      expect(created.displayName).toEqual("premium-sites");

      const fetched = yield* dv.getPartnersChannels({
        partnerId: created.partnerId,
        channelId: created.channelId,
      });
      expect(fetched.channelId).toEqual(created.channelId);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Displayvideo.PartnersChannel("Premium", {
            partnerId,
            channelId: created.channelId,
            displayName: "premium-sites-v2",
          });
        }),
      );

      expect(updated.channelId).toEqual(created.channelId);
      expect(updated.displayName).toEqual("premium-sites-v2");

      yield* stack.destroy();

      // DV360 has no Channels.delete — destroy strips the ownership prefix.
      const leftover = yield* dv.getPartnersChannels({
        partnerId: created.partnerId,
        channelId: created.channelId,
      });
      expect(leftover.displayName ?? "").not.toContain("alchemy-id=");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
