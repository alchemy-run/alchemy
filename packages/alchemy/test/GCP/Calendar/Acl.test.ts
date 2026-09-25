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

const waitUntilGone = (calendarId: string, ruleId: string) =>
  calendar.getAcl({ calendarId, ruleId }).pipe(
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
  "getAcl on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.getAcl({
          calendarId: "alchemy-missing-calendar@group.calendar.google.com",
          ruleId: "user:missing@example.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CALENDAR)(
  "insertAcl without Calendar access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        calendar.insertAcl({
          calendarId: "alchemy-missing-calendar@group.calendar.google.com",
          sendNotifications: false,
          body: {
            role: "reader",
            scope: { type: "user", value: "reader@example.com" },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an ACL rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            summary: "Engineering",
            timeZone: "UTC",
          });
          return yield* GCP.Calendar.Acl("Ada", {
            calendarId: cal.calendarId,
            role: "reader",
            scope: { type: "user", value: "reader@example.com" },
            sendNotifications: false,
          });
        }),
      );

      expect(created.ruleId.length).toBeGreaterThan(0);
      expect(created.calendarId.length).toBeGreaterThan(0);
      expect(created.role).toEqual("reader");
      expect(created.scope?.type).toEqual("user");

      const fetched = yield* calendar.getAcl({
        calendarId: created.calendarId,
        ruleId: created.ruleId,
      });
      expect(fetched.id).toEqual(created.ruleId);
      expect(fetched.role).toEqual("reader");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cal = yield* GCP.Calendar.Calendar("Team", {
            calendarId: created.calendarId,
            summary: "Engineering",
            timeZone: "UTC",
          });
          return yield* GCP.Calendar.Acl("Ada", {
            calendarId: cal.calendarId,
            ruleId: created.ruleId,
            role: "writer",
            scope: { type: "user", value: "reader@example.com" },
            sendNotifications: false,
          });
        }),
      );

      expect(updated.ruleId).toEqual(created.ruleId);
      expect(updated.role).toEqual("writer");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.calendarId, created.ruleId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
