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

export type CoursesTeacherProfile = {
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

export type CoursesTeacherProps = {
  /**
   * Identifier of the parent course (Classroom-assigned id or alias).
   * Immutable — changing it replaces the teacher membership.
   */
  courseId: string;
  /**
   * User to add as a teacher. Numeric user id, email address, or `"me"`.
   * Immutable — changing it replaces the membership. Domain admins may
   * add users in their domain directly; other callers should send an
   * Invitation instead.
   */
  userId: string;
};

export type CoursesTeacher = Resource<
  "GCP.Classroom.CoursesTeacher",
  CoursesTeacherProps,
  {
    /** Parent course id. */
    courseId: string;
    /** Canonical numeric user id. */
    userId: string;
    /** Project id used when the membership was reconciled. */
    project: string;
    /** Global user profile, when returned. */
    profile: CoursesTeacherProfile | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Classroom teacher membership on a course.
 *
 * Teachers have no labels or description, so Alchemy treats identity as
 * `(courseId, userId)` and lists memberships of alchemy-owned courses
 * (ownership stamped on the parent course description) for `list` /
 * nuke. There is nothing mutable beyond identity — changing course or
 * user replaces the membership. The course owner cannot be removed.
 *
 * ### Creating a Teacher
 * **Example:** Add a domain teacher by email
 * ```typescript
 * const teacher = yield* GCP.Classroom.CoursesTeacher("Ada", {
 *   courseId: course.id,
 *   userId: "ada@example.edu",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesTeacher = Resource<CoursesTeacher>(
  "GCP.Classroom.CoursesTeacher",
);

export class CoursesTeacherNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesTeacherNotResolved",
)<{
  courseId: string;
  userId: string;
}> {}

const profileOf = (
  profile: classroom.UserProfile | undefined,
): CoursesTeacherProfile | undefined => {
  if (profile === undefined) return undefined;
  return {
    id: profile.id,
    emailAddress: profile.emailAddress,
    fullName: profile.name?.fullName,
    photoUrl: profile.photoUrl,
    verifiedTeacher: profile.verifiedTeacher === true,
  };
};

const toAttrs = (teacher: classroom.Teacher, project: string) => ({
  courseId: teacher.courseId ?? "",
  userId: teacher.userId ?? teacher.profile?.id ?? "",
  project,
  profile: profileOf(teacher.profile),
});

const sameUser = (teacher: classroom.Teacher, userId: string) =>
  sameText(teacher.userId, userId) ||
  sameText(teacher.profile?.id, userId) ||
  sameText(teacher.profile?.emailAddress, userId);

const getByUser = (courseId: string, userId: string) =>
  courseId.length === 0 || userId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesTeachers({ courseId, userId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (courseId: string, project: string) =>
  classroom.listCoursesTeachers.pages({ courseId, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.teachers ?? [])),
    Stream.map((teacher) => toAttrs(teacher, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

export const CoursesTeacherProvider = () =>
  Provider.succeed(CoursesTeacher, {
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
          .createCoursesTeachers({
            courseId,
            body: { userId },
          })
          .pipe(Effect.catchTag("Conflict", () => getByUser(courseId, userId)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesTeacherNotResolved({ courseId, userId });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.courseId.length === 0 || output.userId.length === 0) {
        return;
      }
      yield* classroom
        .deleteCoursesTeachers({
          courseId: output.courseId,
          userId: output.userId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
