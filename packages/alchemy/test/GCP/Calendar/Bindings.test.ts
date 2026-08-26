import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!runLifecycle)(
  "GetCalendar and GetEvent round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            summary: "Engineering",
            timeZone: "UTC",
          });
          const event = yield* GCP.Calendar.Event("Kickoff", {
            calendarId: cal.calendarId,
            summary: "Kickoff",
            start: { date: "2030-01-15" },
            end: { date: "2030-01-16" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* cal.calendarId;
              yield* event.eventId;
              const getCalendar = yield* GCP.Calendar.GetCalendar(cal);
              const getEvent = yield* GCP.Calendar.GetEvent(event);
              return Effect.fn(function* () {
                const calendarMeta = yield* getCalendar({});
                const eventMeta = yield* getEvent({});
                return { calendarMeta, eventMeta };
              });
            }),
          );
          const { calendarMeta, eventMeta } = yield* Probe({});
          return { cal, event, calendarMeta, eventMeta };
        }),
      );

      expect(out.calendarMeta.id).toEqual(out.cal.calendarId);
      expect(out.calendarMeta.summary).toEqual("Engineering");
      expect(out.eventMeta.id).toEqual(out.event.eventId);
      expect(out.eventMeta.summary).toEqual("Kickoff");
      expect(out.eventMeta.extendedProperties?.private?.alchemy).toEqual(
        "true",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
