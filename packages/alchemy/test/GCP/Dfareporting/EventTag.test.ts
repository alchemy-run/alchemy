import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  advertiserIdFromEnv,
  hasGcpCreds,
  logLevel,
  resolveProfileId,
  runAdvertiserLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (profileId: string, id: string) =>
  dfa.getEventTags({ profileId, id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getEventTags on a missing tag fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getEventTags({ profileId: "1", id: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertEventTags without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertEventTags({
          profileId: "1",
          body: {
            advertiserId: "1",
            name: "alchemy-dfareporting-probe",
            type: "IMPRESSION_IMAGE_EVENT_TAG",
            url: "https://example.com/pixel",
            status: "ENABLED",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runAdvertiserLifecycle)(
  "create, update, and delete an event tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));
      const advertiserId = advertiserIdFromEnv!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.EventTag("Pixel", {
            profileId: profileId!,
            advertiserId,
            name: "alchemy-pixel",
            type: "IMPRESSION_IMAGE_EVENT_TAG",
            url: "https://example.com/pixel",
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.advertiserId).toEqual(advertiserId);
      expect(created.name).toEqual("alchemy-pixel");
      expect(created.status).toEqual("ENABLED");

      const fetched = yield* dfa.getEventTags({
        profileId: created.profileId,
        id: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.EventTag("Pixel", {
            profileId: created.profileId,
            advertiserId: created.advertiserId,
            id: created.id,
            name: "alchemy-pixel-v2",
            type: "IMPRESSION_IMAGE_EVENT_TAG",
            url: "https://example.com/pixel",
            status: "DISABLED",
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("alchemy-pixel-v2");
      expect(updated.status).toEqual("DISABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.profileId, created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
