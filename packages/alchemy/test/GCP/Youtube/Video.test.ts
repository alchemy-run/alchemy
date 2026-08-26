import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as youtube from "@distilled.cloud/gcp/youtube_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_YOUTUBE && !process.env.FAST;

const waitUntilGone = (videoId: string) =>
  youtube.listVideos({ part: ["id"], id: [videoId] }).pipe(
    Effect.map((page) =>
      (page.items ?? []).length === 0 ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "listVideos on a missing video returns empty or a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* youtube
        .listVideos({ part: ["id"], id: ["aaaaaaaaaaa"] })
        .pipe(Effect.result);
      if (Result.isSuccess(result)) {
        expect(result.success.items ?? []).toEqual([]);
      } else {
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(
          result.failure._tag,
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "insertVideos without a media upload fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        youtube.insertVideos({
          part: ["snippet", "status"],
          notifySubscribers: false,
          body: {
            snippet: {
              title: "alchemy-youtube-probe",
              description: "alchemy probe",
              categoryId: "22",
            },
            status: { privacyStatus: "private" },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a video",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Youtube.Video("Clip", {
            title: "alchemy-clip",
            privacyStatus: "private",
          });
        }),
      );

      expect(created.videoId).toEqual(expect.any(String));
      expect(created.title).toEqual("alchemy-clip");

      const fetched = yield* youtube.listVideos({
        part: ["snippet", "status"],
        id: [created.videoId],
      });
      expect(fetched.items?.[0]?.id).toEqual(created.videoId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Youtube.Video("Clip", {
            videoId: created.videoId,
            title: "alchemy-clip-v2",
            privacyStatus: "private",
          });
        }),
      );
      expect(updated.videoId).toEqual(created.videoId);
      expect(updated.title).toEqual("alchemy-clip-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.videoId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
