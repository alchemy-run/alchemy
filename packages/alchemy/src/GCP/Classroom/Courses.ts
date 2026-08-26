import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  archiveThenDeleteCourse,
  DEFAULT_OWNER,
  encodeOwnership,
  findOwnedCourse,
  getCourse,
  hasOwnershipMarker,
  isAliasId,
  listCourses,
  lookupCourseId,
  MAX_COURSE_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toCourseAlias,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type CoursesProps = {
  /**
   * Classroom-assigned course id or an alias (`p:…` project-scoped,
   * `d:…` domain-scoped). If omitted, a project-scoped alias is
   * generated. Immutable — changing it replaces the course.
   */
  courseId?: string;
  /**
   * Course name (for example "10th Grade Biology"). 1-750 characters.
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id.
   */
  name?: string;
  /**
   * Course owner. Numeric user id, email, or `"me"`. Required on
   * create; non-admins can only set themselves.
   * @default "me"
   */
  ownerId?: string;
  /**
   * Section (for example "Period 2"). Max 2800 characters.
   */
  section?: string;
  /**
   * Description heading (for example "Welcome to Biology"). Max 3600
   * characters.
   */
  descriptionHeading?: string;
  /**
   * Course description. Classroom courses have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes. Max 30,000 characters including the prefix.
   */
  description?: string;
  /**
   * Room location (for example "301"). Max 650 characters.
   */
  room?: string;
  /**
   * Optional subject.
   */
  subject?: string;
  /**
   * Optional levels (for example "9th grade"). Fewer than 1000
   * characters.
   */
  levels?: string;
  /**
   * Course state. Unspecified defaults to `PROVISIONED`.
   */
  courseState?: classroom.CourseCourseStateEnum | (string & {});
};

export type Courses = Resource<
  "GCP.Classroom.Courses",
  CoursesProps,
  {
    /** Classroom-assigned course id. */
    courseId: string;
    /** Project-scoped or domain-scoped alias used on create, if any. */
    alias: string | undefined;
    /** Course name. */
    name: string;
    /** Owner identifier. */
    ownerId: string | undefined;
    /** Section. */
    section: string | undefined;
    /** Description heading. */
    descriptionHeading: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Room. */
    room: string | undefined;
    /** Subject. */
    subject: string | undefined;
    /** Levels. */
    levels: string | undefined;
    /** Course state. */
    courseState: string | undefined;
    /** Enrollment code. */
    enrollmentCode: string | undefined;
    /** Alternate Classroom UI link. */
    alternateLink: string | undefined;
    /** Course Calendar id, once the course is ACTIVE. */
    calendarId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Classroom course.
 *
 * Classroom courses have no labels field, so Alchemy stamps ownership
 * into `description` for `list` / nuke. The course id (or alias) is
 * identity — changing `courseId` replaces the course. Name, section,
 * description, room, subject, levels, and state update in place.
 * Delete archives the course first when needed.
 *
 * ### Creating a Course
 * **Example:** Generated alias
 * ```typescript
 * const course = yield* GCP.Classroom.Courses("Biology", {
 *   name: "Biology",
 *   ownerId: "me",
 *   courseState: "PROVISIONED",
 * });
 * ```
 *
 * **Example:** Explicit alias, section, and room
 * ```typescript
 * const course = yield* GCP.Classroom.Courses("Biology", {
 *   courseId: "p:bio-101",
 *   name: "Biology 101",
 *   section: "Period 2",
 *   room: "301",
 *   description: "cells and ecosystems",
 *   ownerId: "me",
 * });
 * ```
 *
 * ### Updating a Course
 * **Example:** Change the name and room
 * ```typescript
 * const course = yield* GCP.Classroom.Courses("Biology", {
 *   courseId: existing.courseId,
 *   name: "Biology 101",
 *   room: "302",
 *   description: "cells and ecosystems",
 *   ownerId: "me",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const Courses = Resource<Courses>("GCP.Classroom.Courses");

export class CoursesNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesNotResolved",
)<{
  courseId: string;
}> {}

const toAttrs = (course: classroom.Course, alias?: string) => {
  const parsed = parseOwnership(course.description);
  return {
    courseId: course.id ?? "",
    alias:
      alias !== undefined && isAliasId(alias)
        ? alias
        : isAliasId(course.id ?? "")
          ? course.id
          : alias,
    name: (course.name ?? "").slice(0, MAX_COURSE_NAME_LENGTH),
    ownerId: course.ownerId,
    section: course.section,
    descriptionHeading: course.descriptionHeading,
    description: parsed.text,
    room: course.room,
    subject: course.subject,
    levels: course.levels,
    courseState: course.courseState,
    enrollmentCode: course.enrollmentCode,
    alternateLink: course.alternateLink,
    calendarId: course.calendarId,
    creationTime: course.creationTime,
    updateTime: course.updateTime,
  };
};

export const CoursesProvider = () =>
  Provider.succeed(Courses, {
    stables: ["courseId", "alias", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.courseId ?? output?.courseId;
      const previousAlias = output?.alias;
      if (
        news.courseId !== undefined &&
        previousId !== undefined &&
        news.courseId !== previousId &&
        news.courseId !== previousAlias
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const alias = yield* toCourseAlias(id, olds?.courseId, output?.alias);
      const lookup = lookupCourseId(olds?.courseId, output?.courseId, alias);
      let existing = yield* getCourse(lookup);
      if (existing === undefined && alias !== lookup) {
        existing = yield* getCourse(alias);
      }
      if (existing === undefined) {
        existing = yield* findOwnedCourse(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, alias);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const courses = yield* listCourses();
        return courses
          .filter((course) => hasOwnershipMarker(course.description))
          .map((course) => toAttrs(course));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const ownership = yield* ownershipLabels(id);
      const alias = yield* toCourseAlias(id, news.courseId, output?.alias);
      const lookup = lookupCourseId(news.courseId, output?.courseId, alias);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const ownerId = news.ownerId ?? output?.ownerId ?? DEFAULT_OWNER;
      const description = encodeOwnership(ownership, news.description);
      const desired: classroom.Course = {
        name,
        ownerId,
        section: news.section,
        descriptionHeading: news.descriptionHeading,
        description,
        room: news.room,
        subject: news.subject,
        levels: news.levels,
        courseState: news.courseState,
      };

      let current = yield* getCourse(output?.courseId ?? lookup);
      if (current === undefined && alias !== lookup) {
        current = yield* getCourse(alias);
      }
      if (current === undefined) {
        current = yield* findOwnedCourse(id);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCourses({
            body: {
              ...desired,
              id: alias,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getCourse(alias)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesNotResolved({ courseId: lookup });
      }

      const courseId = current.id ?? lookup;
      const nameChanged = (current.name ?? "") !== name;
      const sectionChanged = !sameText(current.section, news.section);
      const headingChanged = !sameText(
        current.descriptionHeading,
        news.descriptionHeading,
      );
      const descriptionChanged = (current.description ?? "") !== description;
      const roomChanged = !sameText(current.room, news.room);
      const subjectChanged = !sameText(current.subject, news.subject);
      const levelsChanged = !sameText(current.levels, news.levels);
      const stateChanged =
        news.courseState !== undefined &&
        (current.courseState ?? "") !== news.courseState;
      const ownerChanged =
        news.ownerId !== undefined && (current.ownerId ?? "") !== news.ownerId;

      const updateMask = updateMaskOf(
        nameChanged ? "name" : undefined,
        sectionChanged ? "section" : undefined,
        headingChanged ? "descriptionHeading" : undefined,
        descriptionChanged ? "description" : undefined,
        roomChanged ? "room" : undefined,
        subjectChanged ? "subject" : undefined,
        levelsChanged ? "levels" : undefined,
        stateChanged ? "courseState" : undefined,
        ownerChanged ? "ownerId" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* classroom.patchCourses({
          id: courseId,
          updateMask,
          body: desired,
        });
      }

      return toAttrs(current, alias);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* archiveThenDeleteCourse(output.courseId);
    }),
  });
