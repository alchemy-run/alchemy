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
  classroom.getCoursesCourseWork({ courseId, id }).pipe(
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
  "getCoursesCourseWork on missing course work fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getCoursesCourseWork({
          courseId: "alchemy-missing-course",
          id: "alchemy-missing-work",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete course work",
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
          return yield* GCP.Classroom.CoursesCourseWork("Homework", {
            courseId: course.courseId,
            title: "Week 1 homework",
            description: "read chapter 1",
            workType: "ASSIGNMENT",
            state: "DRAFT",
            maxPoints: 10,
          });
        }),
      );

      expect(created.courseWorkId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Week 1 homework");
      expect(created.description).toEqual("read chapter 1");
      expect(created.maxPoints).toEqual(10);

      const fetched = yield* classroom.getCoursesCourseWork({
        courseId: created.courseId,
        id: created.courseWorkId,
      });
      expect(fetched.id).toEqual(created.courseWorkId);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const course = yield* GCP.Classroom.Courses("Biology", {
            courseId: created.courseId,
            name: "Biology",
            ownerId: "me",
            courseState: "PROVISIONED",
          });
          return yield* GCP.Classroom.CoursesCourseWork("Homework", {
            courseId: course.courseId,
            courseWorkId: created.courseWorkId,
            title: "Week 1 homework",
            description: "read chapters 1-2",
            workType: "ASSIGNMENT",
            state: "DRAFT",
            maxPoints: 20,
          });
        }),
      );

      expect(updated.courseWorkId).toEqual(created.courseWorkId);
      expect(updated.description).toEqual("read chapters 1-2");
      expect(updated.maxPoints).toEqual(20);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.courseId, created.courseWorkId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
