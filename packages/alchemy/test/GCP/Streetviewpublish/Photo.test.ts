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
  probePhotoAccess,
} from "./common.ts";
import { EQUIRECTANGULAR_JPEG_BASE64 } from "./fixtures/equirectangular.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (photoId: string) =>
  streetviewpublish.getPhoto({ photoId, view: "BASIC" }).pipe(
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
  "getPhoto on a missing photo fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        streetviewpublish.getPhoto({
          photoId: "alchemy-missing-photo-id",
          view: "BASIC",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a photo",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probePhotoAccess;
      if (access !== "ok") {
        expect(entitlementTags).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Streetviewpublish.Photo("Corner", {
            photoBytes: EQUIRECTANGULAR_JPEG_BASE64,
            pose: {
              latLngPair: { latitude: 37.422, longitude: -122.084 },
              heading: 0,
            },
          });
        }),
      );

      expect(created.photoId.length).toBeGreaterThan(0);
      expect(created.pose?.level?.name).toEqual("alc");

      const fetched = yield* streetviewpublish.getPhoto({
        photoId: created.photoId,
        view: "BASIC",
      });
      expect(fetched.photoId?.id).toEqual(created.photoId);
      expect(fetched.pose?.level?.name).toEqual("alc");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Streetviewpublish.Photo("Corner", {
            photoId: created.photoId,
            pose: {
              latLngPair: { latitude: 37.422, longitude: -122.084 },
              heading: 90,
            },
          });
        }),
      );

      expect(updated.photoId).toEqual(created.photoId);
      expect(updated.pose?.heading).toEqual(90);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.photoId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
