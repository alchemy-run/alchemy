import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CALENDAR;

const waitUntilGone = (calendarId: string) =>
  calendar.getCalendars({ calendarId }).pipe(
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
  "getCalendars on a missing calendar fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.getCalendars({
          calendarId: "alchemy-missing-calendar@group.calendar.google.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CALENDAR)(
  "insertCalendars without Calendar access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.insertCalendars({
          body: { summary: "Alchemy Calendar Probe" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a calendar",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Calendar.Calendar("Team", {
            summary: "Engineering",
            timeZone: "UTC",
            location: "Chicago",
          });
        }),
      );

      expect(created.calendarId.length).toBeGreaterThan(0);
      expect(created.summary).toEqual("Engineering");
      expect(created.location).toEqual("Chicago");

      const fetched = yield* calendar.getCalendars({
        calendarId: created.calendarId,
      });
      expect(fetched.id).toEqual(created.calendarId);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Calendar.Calendar("Team", {
            calendarId: created.calendarId,
            summary: "Platform",
            timeZone: "UTC",
            location: "Austin",
          });
        }),
      );

      expect(updated.calendarId).toEqual(created.calendarId);
      expect(updated.summary).toEqual("Platform");
      expect(updated.location).toEqual("Austin");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.calendarId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
