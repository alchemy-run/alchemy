import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as streetviewpublish from "@distilled.cloud/gcp/streetviewpublish_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probeSequenceAccess,
} from "./common.ts";
import { MINIMAL_MP4_BASE64 } from "./fixtures/equirectangular.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (sequenceId: string) =>
  streetviewpublish.getPhotoSequence({ sequenceId, view: "BASIC" }).pipe(
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
  "getPhotoSequence on a missing sequence fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        streetviewpublish.getPhotoSequence({
          sequenceId: "alchemy-missing-sequence-id",
          view: "BASIC",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create and delete a photo sequence",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeSequenceAccess;
      if (access !== "ok") {
        expect(entitlementTags).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Streetviewpublish.PhotoSequence("Walk", {
            sequenceBytes: MINIMAL_MP4_BASE64,
            inputType: "VIDEO",
            rawGpsTimeline: [
              {
                latLngPair: { latitude: 37.422, longitude: -122.084 },
              },
            ],
          });
        }),
      );

      expect(created.sequenceId.length).toBeGreaterThan(0);

      const fetched = yield* streetviewpublish.getPhotoSequence({
        sequenceId: created.sequenceId,
        view: "BASIC",
      });
      expect(fetched.name).toContain(created.sequenceId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.sequenceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
