import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteCourse, ensureCourse } from "./parent.ts";

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

const waitUntilGone = (courseId: string, topicId: string) =>
  classroom.getCoursesTopics({ courseId, id: topicId }).pipe(
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
  "getCoursesTopics on a missing topic fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getCoursesTopics({
          courseId: "missing-course",
          id: "missing-topic",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const course = yield* ensureCourse("alch-topic");
      const courseId = course.id ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Classroom.CoursesTopic("Week1", {
            courseId,
            name: "Week 1",
          });
        }),
      );

      expect(created.courseId).toEqual(courseId);
      expect(created.topicId).toEqual(expect.any(String));
      expect(created.name).toEqual("Week 1");

      const fetched = yield* classroom.getCoursesTopics({
        courseId,
        id: created.topicId,
      });
      expect(fetched.topicId).toEqual(created.topicId);
      expect(fetched.name).toContain("Week 1");
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Classroom.CoursesTopic("Week1", {
            courseId,
            topicId: created.topicId,
            name: "Week 1 intro",
          });
        }),
      );

      expect(updated.topicId).toEqual(created.topicId);
      expect(updated.name).toEqual("Week 1 intro");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(courseId, created.topicId);
      expect(gone).toEqual("gone");

      yield* deleteCourse(courseId);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
