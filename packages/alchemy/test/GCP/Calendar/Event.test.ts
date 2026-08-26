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

const waitUntilGone = (calendarId: string, eventId: string) =>
  calendar.getEvents({ calendarId, eventId }).pipe(
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
  "getEvents on a missing event fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.getEvents({
          calendarId: "primary",
          eventId: "alchemyMissingEventId000",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CALENDAR)(
  "insertEvents without Calendar access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.insertEvents({
          calendarId: "primary",
          sendUpdates: "none",
          body: {
            summary: "Alchemy Event Probe",
            start: { date: "2030-01-15" },
            end: { date: "2030-01-16" },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            summary: "Engineering",
            timeZone: "UTC",
          });
          return yield* GCP.Calendar.Event("Kickoff", {
            calendarId: cal.calendarId,
            summary: "Kickoff",
            start: { date: "2030-01-15" },
            end: { date: "2030-01-16" },
            location: "HQ",
          });
        }),
      );

      expect(created.eventId.length).toBeGreaterThan(0);
      expect(created.calendarId.length).toBeGreaterThan(0);
      expect(created.summary).toEqual("Kickoff");
      expect(created.location).toEqual("HQ");
      expect(created.start?.date).toEqual("2030-01-15");

      const fetched = yield* calendar.getEvents({
        calendarId: created.calendarId,
        eventId: created.eventId,
      });
      expect(fetched.id).toEqual(created.eventId);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.extendedProperties?.private?.alchemy).toEqual("true");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            calendarId: created.calendarId,
            summary: "Engineering",
            timeZone: "UTC",
          });
          return yield* GCP.Calendar.Event("Kickoff", {
            calendarId: cal.calendarId,
            eventId: created.eventId,
            summary: "Kickoff (moved)",
            start: { date: "2030-01-16" },
            end: { date: "2030-01-17" },
            location: "Remote",
          });
        }),
      );

      expect(updated.eventId).toEqual(created.eventId);
      expect(updated.summary).toEqual("Kickoff (moved)");
      expect(updated.location).toEqual("Remote");
      expect(updated.start?.date).toEqual("2030-01-16");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.calendarId, created.eventId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
