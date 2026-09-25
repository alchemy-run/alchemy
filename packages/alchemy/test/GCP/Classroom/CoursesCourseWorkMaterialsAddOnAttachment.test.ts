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
    .getCoursesCourseWorkMaterialsAddOnAttachments({
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
  "getCoursesCourseWorkMaterialsAddOnAttachments on a missing attachment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getCoursesCourseWorkMaterialsAddOnAttachments({
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
  "create, update, and delete a course work material add-on attachment",
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
          const material = yield* GCP.Classroom.CoursesCourseWorkMaterial(
            "Reading",
            {
              courseId: course.courseId,
              title: "Week 1 reading",
              description: "syllabus",
              state: "DRAFT",
            },
          );
          return yield* GCP.Classroom.CoursesCourseWorkMaterialsAddOnAttachment(
            "Widget",
            {
              courseId: course.courseId,
              itemId: material.courseWorkMaterialId,
              title: "Interactive widget",
              studentViewUri: { uri: "https://example.com/student" },
              teacherViewUri: { uri: "https://example.com/teacher" },
            },
          );
        }),
      );

      expect(created.attachmentId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Interactive widget");

      const fetched =
        yield* classroom.getCoursesCourseWorkMaterialsAddOnAttachments({
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
          const material = yield* GCP.Classroom.CoursesCourseWorkMaterial(
            "Reading",
            {
              courseId: course.courseId,
              courseWorkMaterialId: created.itemId,
              title: "Week 1 reading",
              description: "syllabus",
              state: "DRAFT",
            },
          );
          return yield* GCP.Classroom.CoursesCourseWorkMaterialsAddOnAttachment(
            "Widget",
            {
              courseId: course.courseId,
              itemId: material.courseWorkMaterialId,
              attachmentId: created.attachmentId,
              title: "Interactive widget v2",
              studentViewUri: { uri: "https://example.com/student" },
              teacherViewUri: { uri: "https://example.com/teacher" },
            },
          );
        }),
      );

      expect(updated.attachmentId).toEqual(created.attachmentId);
      expect(updated.title).toEqual("Interactive widget v2");

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
