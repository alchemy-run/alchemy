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
  calendar.getCalendarList({ calendarId }).pipe(
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
  "getCalendarList on a missing entry fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.getCalendarList({
          calendarId: "alchemy-missing-calendar@group.calendar.google.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CALENDAR)(
  "insertCalendarList without Calendar access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.insertCalendarList({
          body: {
            id: "alchemy-missing-calendar@group.calendar.google.com",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a calendar list entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            summary: "Engineering",
            timeZone: "UTC",
          });
          return yield* GCP.Calendar.CalendarList("TeamList", {
            calendarId: cal.calendarId,
            summaryOverride: "Engineering",
            selected: true,
          });
        }),
      );

      expect(created.calendarId.length).toBeGreaterThan(0);
      expect(created.summaryOverride).toEqual("Engineering");
      expect(created.selected).toEqual(true);

      const fetched = yield* calendar.getCalendarList({
        calendarId: created.calendarId,
      });
      expect(fetched.id).toEqual(created.calendarId);
      expect(fetched.summaryOverride).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            calendarId: created.calendarId,
            summary: "Engineering",
            timeZone: "UTC",
          });
          return yield* GCP.Calendar.CalendarList("TeamList", {
            calendarId: cal.calendarId,
            summaryOverride: "Platform",
            selected: false,
            hidden: true,
          });
        }),
      );

      expect(updated.calendarId).toEqual(created.calendarId);
      expect(updated.summaryOverride).toEqual("Platform");
      expect(updated.hidden).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.calendarId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
