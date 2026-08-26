import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probePhotoAccess,
} from "./common.ts";
import { EQUIRECTANGULAR_JPEG_BASE64 } from "./fixtures/equirectangular.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetPhoto round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probePhotoAccess;
      if (access !== "ok") {
        expect(entitlementTags).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const photo = yield* GCP.Streetviewpublish.Photo("Corner", {
            photoBytes: EQUIRECTANGULAR_JPEG_BASE64,
            pose: {
              latLngPair: { latitude: 37.422, longitude: -122.084 },
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* photo.photoId;
              const getPhoto = yield* GCP.Streetviewpublish.GetPhoto(photo);
              return Effect.fn(function* () {
                return yield* getPhoto({ view: "BASIC" });
              });
            }),
          );
          return { photo, metadata: yield* Probe({}) };
        }),
      );

      expect(out.metadata.photoId?.id).toEqual(out.photo.photoId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
