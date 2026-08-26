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

const waitUntilGone = (courseId: string, courseWorkId: string, id: string) =>
  classroom.getCoursesCourseWorkRubrics({ courseId, courseWorkId, id }).pipe(
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
  "getCoursesCourseWorkRubrics on a missing rubric fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getCoursesCourseWorkRubrics({
          courseId: "alchemy-missing-course",
          courseWorkId: "alchemy-missing-work",
          id: "alchemy-missing-rubric",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a course work rubric",
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
          const work = yield* GCP.Classroom.CoursesCourseWork("Homework", {
            courseId: course.courseId,
            title: "Week 1 homework",
            description: "read chapter 1",
            workType: "ASSIGNMENT",
            state: "DRAFT",
          });
          return yield* GCP.Classroom.CoursesCourseWorkRubric("Scale", {
            courseId: course.courseId,
            courseWorkId: work.courseWorkId,
            criteria: [
              {
                title: "Quality",
                description: "overall quality",
                levels: [
                  { title: "Meets", points: 1 },
                  { title: "Exceeds", points: 2 },
                ],
              },
            ],
          });
        }),
      );

      expect(created.rubricId.length).toBeGreaterThan(0);
      expect(created.criteria?.[0]?.title).toEqual("Quality");
      expect(created.criteria?.[0]?.description).toEqual("overall quality");

      const fetched = yield* classroom.getCoursesCourseWorkRubrics({
        courseId: created.courseId,
        courseWorkId: created.courseWorkId,
        id: created.rubricId,
      });
      expect(fetched.id).toEqual(created.rubricId);
      expect(fetched.criteria?.[0]?.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const course = yield* GCP.Classroom.Courses("Biology", {
            courseId: created.courseId,
            name: "Biology",
            ownerId: "me",
            courseState: "PROVISIONED",
          });
          const work = yield* GCP.Classroom.CoursesCourseWork("Homework", {
            courseId: course.courseId,
            courseWorkId: created.courseWorkId,
            title: "Week 1 homework",
            description: "read chapter 1",
            workType: "ASSIGNMENT",
            state: "DRAFT",
          });
          return yield* GCP.Classroom.CoursesCourseWorkRubric("Scale", {
            courseId: course.courseId,
            courseWorkId: work.courseWorkId,
            rubricId: created.rubricId,
            criteria: [
              {
                title: "Quality",
                description: "overall quality",
                levels: [
                  { title: "Developing", points: 1 },
                  { title: "Exceeds", points: 2 },
                ],
              },
            ],
          });
        }),
      );

      expect(updated.rubricId).toEqual(created.rubricId);
      expect(updated.criteria?.[0]?.levels?.[0]?.title).toEqual("Developing");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.courseId,
        created.courseWorkId,
        created.rubricId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
