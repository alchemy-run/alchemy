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

const waitUntilGone = (
  advertiserId: string,
  targetingType: string,
  assignedTargetingOptionId: string,
) =>
  dv
    .getAdvertisersTargetingTypesAssignedTargetingOptions({
      advertiserId,
      targetingType,
      assignedTargetingOptionId,
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
  "getAdvertisersTargetingTypesAssignedTargetingOptions on a missing option fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getAdvertisersTargetingTypesAssignedTargetingOptions({
          advertiserId: "1",
          targetingType: "TARGETING_TYPE_KEYWORD",
          assignedTargetingOptionId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an advertiser assigned targeting option",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const advertiser = yield* GCP.Displayvideo.Advertiser(
            "Brand",
            advertiserProps,
          );
          const option =
            yield* GCP.Displayvideo.AdvertisersTargetingTypesAssignedTargetingOption(
              "Exclude",
              {
                advertiserId: advertiser.advertiserId,
                targetingType: "TARGETING_TYPE_KEYWORD",
                keywordDetails: { keyword: "competitor", negative: true },
              },
            );
          return { advertiser, option };
        }),
      );

      expect(created.option.assignedTargetingOptionId).toEqual(
        expect.any(String),
      );
      expect(created.option.targetingType).toEqual("TARGETING_TYPE_KEYWORD");
      expect(created.option.keywordDetails?.keyword).toEqual("competitor");

      const fetched =
        yield* dv.getAdvertisersTargetingTypesAssignedTargetingOptions({
          advertiserId: created.option.advertiserId,
          targetingType: created.option.targetingType,
          assignedTargetingOptionId: created.option.assignedTargetingOptionId,
        });
      expect(fetched.assignedTargetingOptionId).toEqual(
        created.option.assignedTargetingOptionId,
      );
      expect(fetched.keywordDetails?.negative).toEqual(true);
      expect(fetched.keywordDetails?.keyword).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.option.advertiserId,
        created.option.targetingType,
        created.option.assignedTargetingOptionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
