import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as classroom from "@distilled.cloud/gcp/classroom_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CLASSROOM;

const waitUntilGone = (courseId: string, id: string) =>
  classroom.getCoursesAnnouncements({ courseId, id }).pipe(
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
  "getCoursesAnnouncements on a missing announcement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getCoursesAnnouncements({
          courseId: "alchemy-missing-course",
          id: "alchemy-missing-announcement",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an announcement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const course = yield* GCP.Classroom.Courses("Biology", {
            name: "Biology",
            ownerId: "me",
            courseState: "PROVISIONED",
          });
          return yield* GCP.Classroom.CoursesAnnouncement("Welcome", {
            courseId: course.courseId,
            text: "Welcome to class",
            state: "DRAFT",
          });
        }),
      );

      expect(created.announcementId.length).toBeGreaterThan(0);
      expect(created.courseId.length).toBeGreaterThan(0);
      expect(created.text).toEqual("Welcome to class");
      expect(created.state).toEqual("DRAFT");

      const fetched = yield* classroom.getCoursesAnnouncements({
        courseId: created.courseId,
        id: created.announcementId,
      });
      expect(fetched.id).toEqual(created.announcementId);
      expect(fetched.text).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const course = yield* GCP.Classroom.Courses("Biology", {
            courseId: created.courseId,
            name: "Biology",
            ownerId: "me",
            courseState: "PROVISIONED",
          });
          return yield* GCP.Classroom.CoursesAnnouncement("Welcome", {
            courseId: course.courseId,
            announcementId: created.announcementId,
            text: "Welcome to week 1",
            state: "DRAFT",
          });
        }),
      );

      expect(updated.announcementId).toEqual(created.announcementId);
      expect(updated.text).toEqual("Welcome to week 1");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.courseId,
        created.announcementId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
