import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gamesConfiguration from "@distilled.cloud/gcp/gamesConfiguration_v1configuration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  applicationId,
  hasGcpCreds,
  logLevel,
  probeApplicationId,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (achievementId: string) =>
  gamesConfiguration.getAchievementConfigurations({ achievementId }).pipe(
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
  "getAchievementConfigurations on a missing achievement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gamesConfiguration.getAchievementConfigurations({
          achievementId: "alchemy-missing-achievement",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GAMESCONFIGURATION)(
  "insertAchievementConfigurations without Play Games access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gamesConfiguration.insertAchievementConfigurations({
          applicationId: probeApplicationId,
          body: {
            achievementType: "STANDARD",
            initialState: "REVEALED",
            draft: {
              name: {
                translations: [{ locale: "en-US", value: "Alchemy Probe" }],
              },
              description: {
                translations: [{ locale: "en-US", value: "probe" }],
              },
              pointValue: 5,
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete an achievement configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* gamesConfiguration
        .listAchievementConfigurations({
          applicationId: probeApplicationId,
          maxResults: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
          Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access._tag);
        yield* stack.destroy();
        return;
      }
      if (!applicationId) {
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GamesConfiguration.AchievementConfiguration(
            "FirstWin",
            {
              applicationId: applicationId!,
              name: "First Win",
              description: "Win your first match",
            },
          );
        }),
      );

      expect(created.achievementId.length).toBeGreaterThan(0);
      expect(created.applicationId).toEqual(applicationId);
      expect(created.name).toEqual("First Win");
      expect(created.description).toEqual("Win your first match");

      const fetched = yield* gamesConfiguration.getAchievementConfigurations({
        achievementId: created.achievementId,
      });
      expect(fetched.id).toEqual(created.achievementId);
      expect(fetched.draft?.description?.translations?.[0]?.value).toContain(
        "[alchemy ",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GamesConfiguration.AchievementConfiguration(
            "FirstWin",
            {
              applicationId: created.applicationId,
              achievementId: created.achievementId,
              name: "First Win",
              description: "Win a match",
            },
          );
        }),
      );

      expect(updated.achievementId).toEqual(created.achievementId);
      expect(updated.description).toEqual("Win a match");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.achievementId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
