import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, partnerId, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (
  partnerIdValue: string,
  targetingType: string,
  assignedTargetingOptionId: string,
) =>
  dv
    .getPartnersTargetingTypesAssignedTargetingOptions({
      partnerId: partnerIdValue,
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
  "getPartnersTargetingTypesAssignedTargetingOptions on a missing option fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dv.getPartnersTargetingTypesAssignedTargetingOptions({
          partnerId: "1",
          targetingType: "TARGETING_TYPE_CHANNEL",
          assignedTargetingOptionId: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a partner assigned targeting option",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const channel = yield* GCP.Displayvideo.PartnersChannel("Channel", {
            partnerId,
            displayName: "alchemy-partner-channel",
          });
          const option =
            yield* GCP.Displayvideo.PartnersTargetingTypesAssignedTargetingOption(
              "Block",
              {
                partnerId,
                targetingType: "TARGETING_TYPE_CHANNEL",
                channelDetails: {
                  channelId: channel.channelId,
                  negative: true,
                },
              },
            );
          return { channel, option };
        }),
      );

      expect(created.option.assignedTargetingOptionId).toEqual(
        expect.any(String),
      );
      expect(created.option.targetingType).toEqual("TARGETING_TYPE_CHANNEL");
      expect(created.option.channelDetails?.channelId).toEqual(
        created.channel.channelId,
      );

      const fetched =
        yield* dv.getPartnersTargetingTypesAssignedTargetingOptions({
          partnerId: created.option.partnerId,
          targetingType: created.option.targetingType,
          assignedTargetingOptionId: created.option.assignedTargetingOptionId,
        });
      expect(fetched.assignedTargetingOptionId).toEqual(
        created.option.assignedTargetingOptionId,
      );
      expect(fetched.channelDetails?.channelId).toEqual(
        created.channel.channelId,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.option.partnerId,
        created.option.targetingType,
        created.option.assignedTargetingOptionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
