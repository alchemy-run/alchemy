import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { listOwnedCourses, sameText } from "./internal.ts";

export type CoursesStudentProfile = {
  /** Numeric Classroom user id. */
  id: string | undefined;
  /** Email address, when the profile-emails scope is granted. */
  emailAddress: string | undefined;
  /** Full name, when populated. */
  fullName: string | undefined;
  /** Profile photo URL, when the profile-photos scope is granted. */
  photoUrl: string | undefined;
  /** Whether the domain admin verified this user as a teacher. */
  verifiedTeacher: boolean;
};

export type CoursesStudentFolder = {
  /** Drive folder id. */
  id: string | undefined;
  /** Folder title. */
  title: string | undefined;
  /** URL that opens the folder. */
  alternateLink: string | undefined;
};

export type CoursesStudentProps = {
  /**
   * Identifier of the parent course (Classroom-assigned id or alias).
   * Immutable — changing it replaces the student membership.
   */
  courseId: string;
  /**
   * User to enroll. Numeric user id, email address, or `"me"`. Immutable
   * — changing it replaces the membership.
   */
  userId: string;
  /**
   * Enrollment code of the course. Required when `userId` is the
   * requesting user; domain admins may omit it.
   */
  enrollmentCode?: string;
};

export type CoursesStudent = Resource<
  "GCP.Classroom.CoursesStudent",
  CoursesStudentProps,
  {
    /** Parent course id. */
    courseId: string;
    /** Canonical numeric user id. */
    userId: string;
    /** Project id used when the membership was reconciled. */
    project: string;
    /** Global user profile, when returned. */
    profile: CoursesStudentProfile | undefined;
    /** Student's work folder in this course, when visible. */
    studentWorkFolder: CoursesStudentFolder | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Classroom student membership on a course.
 *
 * Students have no labels or description, so Alchemy treats identity as
 * `(courseId, userId)` and lists memberships of alchemy-owned courses
 * (ownership stamped on the parent course description) for `list` /
 * nuke. There is nothing mutable beyond identity — changing course or
 * user replaces the membership.
 *
 * ### Creating a Student
 * **Example:** Enroll by email
 * ```typescript
 * const student = yield* GCP.Classroom.CoursesStudent("Ada", {
 *   courseId: course.id,
 *   userId: "ada@example.edu",
 * });
 * ```
 *
 * **Example:** Self-enroll with an enrollment code
 * ```typescript
 * const student = yield* GCP.Classroom.CoursesStudent("Me", {
 *   courseId: course.id,
 *   userId: "me",
 *   enrollmentCode: course.enrollmentCode,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesStudent = Resource<CoursesStudent>(
  "GCP.Classroom.CoursesStudent",
);

export class CoursesStudentNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesStudentNotResolved",
)<{
  courseId: string;
  userId: string;
}> {}

const profileOf = (
  profile: classroom.UserProfile | undefined,
): CoursesStudentProfile | undefined => {
  if (profile === undefined) return undefined;
  return {
    id: profile.id,
    emailAddress: profile.emailAddress,
    fullName: profile.name?.fullName,
    photoUrl: profile.photoUrl,
    verifiedTeacher: profile.verifiedTeacher === true,
  };
};

const folderOf = (
  folder: classroom.DriveFolder | undefined,
): CoursesStudentFolder | undefined => {
  if (folder === undefined) return undefined;
  return {
    id: folder.id,
    title: folder.title,
    alternateLink: folder.alternateLink,
  };
};

const toAttrs = (student: classroom.Student, project: string) => ({
  courseId: student.courseId ?? "",
  userId: student.userId ?? student.profile?.id ?? "",
  project,
  profile: profileOf(student.profile),
  studentWorkFolder: folderOf(student.studentWorkFolder),
});

const sameUser = (student: classroom.Student, userId: string) =>
  sameText(student.userId, userId) ||
  sameText(student.profile?.id, userId) ||
  sameText(student.profile?.emailAddress, userId);

const getByUser = (courseId: string, userId: string) =>
  courseId.length === 0 || userId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesStudents({ courseId, userId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (courseId: string, project: string) =>
  classroom.listCoursesStudents.pages({ courseId, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.students ?? [])),
    Stream.map((student) => toAttrs(student, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

export const CoursesStudentProvider = () =>
  Provider.succeed(CoursesStudent, {
    stables: ["courseId", "userId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousUser = olds?.userId ?? output?.userId;
      if (
        previousUser !== undefined &&
        news.userId !== previousUser &&
        news.userId !== output?.profile?.emailAddress &&
        news.userId !== output?.profile?.id
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const userId = olds?.userId ?? output?.userId ?? "";
      const existing =
        (yield* getByUser(courseId, userId)) ??
        (output?.userId !== undefined && output.userId !== userId
          ? yield* getByUser(courseId, output.userId)
          : undefined);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const courses = yield* listOwnedCourses();
        const pages = yield* Effect.forEach(
          courses,
          (course) =>
            course.id ? listAt(course.id, env.project) : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const courseId = news.courseId;
      const userId = news.userId;

      let current =
        (yield* getByUser(courseId, userId)) ??
        (output?.userId !== undefined
          ? yield* getByUser(courseId, output.userId)
          : undefined);

      if (current !== undefined && !sameUser(current, userId)) {
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesStudents({
            courseId,
            enrollmentCode: news.enrollmentCode,
            body: { userId },
          })
          .pipe(Effect.catchTag("Conflict", () => getByUser(courseId, userId)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesStudentNotResolved({ courseId, userId });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.courseId.length === 0 || output.userId.length === 0) {
        return;
      }
      yield* classroom
        .deleteCoursesStudents({
          courseId: output.courseId,
          userId: output.userId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
