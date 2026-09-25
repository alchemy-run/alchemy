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

const waitUntilGone = (
  courseId: string,
  itemId: string,
  attachmentId: string,
) =>
  classroom
    .getCoursesCourseWorkAddOnAttachments({
      courseId,
      itemId,
      attachmentId,
    })
    .pipe(
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
  "getCoursesCourseWorkAddOnAttachments on a missing attachment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getCoursesCourseWorkAddOnAttachments({
          courseId: "alchemy-missing-course",
          itemId: "alchemy-missing-item",
          attachmentId: "alchemy-missing-attachment",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a course work add-on attachment",
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
          return yield* GCP.Classroom.CoursesCourseWorkAddOnAttachment("Lab", {
            courseId: course.courseId,
            itemId: work.courseWorkId,
            title: "Virtual lab",
            studentViewUri: { uri: "https://example.com/student" },
            teacherViewUri: { uri: "https://example.com/teacher" },
          });
        }),
      );

      expect(created.attachmentId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Virtual lab");

      const fetched = yield* classroom.getCoursesCourseWorkAddOnAttachments({
        courseId: created.courseId,
        itemId: created.itemId,
        attachmentId: created.attachmentId,
      });
      expect(fetched.id).toEqual(created.attachmentId);
      expect(fetched.title).toContain("[alchemy ");

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
            courseWorkId: created.itemId,
            title: "Week 1 homework",
            description: "read chapter 1",
            workType: "ASSIGNMENT",
            state: "DRAFT",
          });
          return yield* GCP.Classroom.CoursesCourseWorkAddOnAttachment("Lab", {
            courseId: course.courseId,
            itemId: work.courseWorkId,
            attachmentId: created.attachmentId,
            title: "Virtual lab v2",
            studentViewUri: { uri: "https://example.com/student" },
            teacherViewUri: { uri: "https://example.com/teacher" },
          });
        }),
      );

      expect(updated.attachmentId).toEqual(created.attachmentId);
      expect(updated.title).toEqual("Virtual lab v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.courseId,
        created.itemId,
        created.attachmentId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
