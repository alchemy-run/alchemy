import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const PARENT_DESCRIPTION =
  "[alchemy alchemy-stack=alch alchemy-stage=test alchemy-id=classroom-parent]";

export const getCourse = (id: string) =>
  classroom
    .getCourses({ id })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listCourses = () =>
  classroom.listCourses.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.courses ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

export const ensureCourse = (name: string) =>
  Effect.gen(function* () {
    const courses = yield* listCourses();
    const existing = courses.find(
      (course) =>
        course.name === name &&
        (course.description ?? "").startsWith("[alchemy "),
    );
    if (existing?.id) {
      const current = yield* getCourse(existing.id);
      if (current !== undefined) return current;
    }
    return yield* classroom.createCourses({
      body: {
        name,
        ownerId: "me",
        courseState: "ACTIVE",
        description: PARENT_DESCRIPTION,
        section: "alchemy",
      },
    });
  });

export const deleteCourse = (id: string | undefined) =>
  Effect.gen(function* () {
    if (id === undefined || id.length === 0) return;
    const existing = yield* getCourse(id);
    if (existing === undefined) return;
    yield* classroom
      .deleteCourses({ id })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

export const ensureAnnouncement = (courseId: string, text: string) =>
  Effect.gen(function* () {
    const listed = yield* classroom.listCoursesAnnouncements
      .pages({
        courseId,
        pageSize: 100,
        announcementStates: ["PUBLISHED", "DRAFT"],
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.announcements ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      );
    const existing = listed.find((item) => item.text === text);
    if (existing?.id) return existing;
    return yield* classroom.createCoursesAnnouncements({
      courseId,
      body: { text, state: "PUBLISHED" },
    });
  });

export const deleteAnnouncement = (
  courseId: string | undefined,
  announcementId: string | undefined,
) =>
  Effect.gen(function* () {
    if (
      courseId === undefined ||
      courseId.length === 0 ||
      announcementId === undefined ||
      announcementId.length === 0
    ) {
      return;
    }
    yield* classroom
      .deleteCoursesAnnouncements({ courseId, id: announcementId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });
