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

const waitUntilGone = (advertiserId: string) =>
  dv.getAdvertisers({ advertiserId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertisers on a missing advertiser fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisers({ advertiserId: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an advertiser",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Displayvideo.Advertiser("Brand", advertiserProps);
        }),
      );

      expect(created.advertiserId).toEqual(expect.any(String));
      expect(created.partnerId).toEqual(advertiserProps.partnerId);
      expect(created.displayName).toEqual("alchemy-dv");
      expect(created.entityStatus).toEqual("ENTITY_STATUS_ACTIVE");

      const fetched = yield* dv.getAdvertisers({
        advertiserId: created.advertiserId,
      });
      expect(fetched.advertiserId).toEqual(created.advertiserId);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("alchemy-dv");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Displayvideo.Advertiser("Brand", {
            ...advertiserProps,
            advertiserId: created.advertiserId,
            displayName: "alchemy-dv-v2",
            entityStatus: "ENTITY_STATUS_PAUSED",
          });
        }),
      );

      expect(updated.advertiserId).toEqual(created.advertiserId);
      expect(updated.displayName).toEqual("alchemy-dv-v2");
      expect(updated.entityStatus).toEqual("ENTITY_STATUS_PAUSED");

      const fetchedUpdate = yield* dv.getAdvertisers({
        advertiserId: updated.advertiserId,
      });
      expect(fetchedUpdate.entityStatus).toEqual("ENTITY_STATUS_PAUSED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.advertiserId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
