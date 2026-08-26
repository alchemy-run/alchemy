import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  courseIdsOf,
  encodeOwnership,
  hasOwnershipMarker,
  individualStudentsOf,
  type IndividualStudentsOptions,
  listAnnouncements,
  listOwnedCourses,
  type Material,
  materialsOf,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type CoursesAnnouncementProps = {
  /**
   * Parent course id (Classroom-assigned id or alias). Immutable —
   * changing it replaces the announcement.
   */
  courseId: string;
  /**
   * Classroom-assigned announcement id. Server-assigned on create.
   * Immutable — changing it replaces the announcement.
   */
  announcementId?: string;
  /**
   * Announcement text. Classroom announcements have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes. Max 30,000 characters including the prefix.
   */
  text?: string;
  /**
   * Announcement state. Unspecified defaults to `DRAFT`.
   */
  state?: classroom.AnnouncementStateEnum | (string & {});
  /**
   * Assignee mode. Unspecified defaults to `ALL_STUDENTS`.
   */
  assigneeMode?: classroom.AnnouncementAssigneeModeEnum | (string & {});
  /**
   * Students with access when `assigneeMode` is `INDIVIDUAL_STUDENTS`.
   */
  individualStudentsOptions?: IndividualStudentsOptions;
  /**
   * Optional RFC3339 timestamp when this announcement is scheduled to
   * be published.
   */
  scheduledTime?: string;
  /**
   * Additional materials (max 20).
   */
  materials?: Material[];
};

export type CoursesAnnouncement = Resource<
  "GCP.Classroom.CoursesAnnouncement",
  CoursesAnnouncementProps,
  {
    /** Classroom-assigned announcement id. */
    announcementId: string;
    /** Parent course id. */
    courseId: string;
    /** User text with the Alchemy ownership prefix stripped. */
    text: string | undefined;
    /** Announcement state. */
    state: string | undefined;
    /** Assignee mode. */
    assigneeMode: string | undefined;
    /** Individual-student options. */
    individualStudentsOptions: IndividualStudentsOptions | undefined;
    /** Scheduled publish time. */
    scheduledTime: string | undefined;
    /** Materials. */
    materials: Material[] | undefined;
    /** Creator user id. */
    creatorUserId: string | undefined;
    /** Alternate Classroom UI link when published. */
    alternateLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Classroom announcement on a course stream.
 *
 * Alchemy stamps ownership into `text` for `list` / nuke. Parent course
 * and announcement id are identity. Text, state, schedule, and
 * assignee mode update in place.
 *
 * ### Creating an Announcement
 * **Example:** Draft announcement
 * ```typescript
 * const announcement = yield* GCP.Classroom.CoursesAnnouncement(
 *   "Welcome",
 *   {
 *     courseId: course.courseId,
 *     text: "Welcome to class",
 *     state: "DRAFT",
 *   },
 * );
 * ```
 *
 * ### Updating an Announcement
 * **Example:** Publish the announcement
 * ```typescript
 * const announcement = yield* GCP.Classroom.CoursesAnnouncement(
 *   "Welcome",
 *   {
 *     courseId: existing.courseId,
 *     announcementId: existing.announcementId,
 *     text: "Welcome to class",
 *     state: "PUBLISHED",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesAnnouncement = Resource<CoursesAnnouncement>(
  "GCP.Classroom.CoursesAnnouncement",
);

export class CoursesAnnouncementNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesAnnouncementNotResolved",
)<{
  courseId: string;
  announcementId: string;
}> {}

const getById = (courseId: string, id: string) =>
  courseId.length === 0 || id.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesAnnouncements({ courseId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (announcement: classroom.Announcement) => {
  const parsed = parseOwnership(announcement.text);
  return {
    announcementId: announcement.id ?? "",
    courseId: announcement.courseId ?? "",
    text: parsed.text,
    state: announcement.state,
    assigneeMode: announcement.assigneeMode,
    individualStudentsOptions: individualStudentsOf(
      announcement.individualStudentsOptions,
    ),
    scheduledTime: announcement.scheduledTime,
    materials: materialsOf(announcement.materials),
    creatorUserId: announcement.creatorUserId,
    alternateLink: announcement.alternateLink,
    creationTime: announcement.creationTime,
    updateTime: announcement.updateTime,
  };
};

const findOwned = (courseId: string, id: string) =>
  Effect.gen(function* () {
    const items = yield* listAnnouncements(courseId);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.text)) {
        return item;
      }
    }
    return undefined;
  });

export const CoursesAnnouncementProvider = () =>
  Provider.succeed(CoursesAnnouncement, {
    stables: ["announcementId", "courseId", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.announcementId ?? output?.announcementId;
      if (
        previousId !== undefined &&
        news.announcementId !== undefined &&
        news.announcementId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const announcementId = olds?.announcementId ?? output?.announcementId;
      let existing =
        announcementId !== undefined
          ? yield* getById(courseId, announcementId)
          : undefined;
      if (existing === undefined) {
        existing = yield* findOwned(courseId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.text))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const courses = yield* listOwnedCourses();
        const pages = yield* Effect.forEach(
          courseIdsOf(courses),
          (courseId) => listAnnouncements(courseId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((item) => hasOwnershipMarker(item.text))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const courseId = news.courseId;
      const announcementId = news.announcementId ?? output?.announcementId;
      const ownership = yield* ownershipLabels(id);
      const text = encodeOwnership(ownership, news.text);
      const body: classroom.Announcement = {
        text,
        state: news.state,
        assigneeMode: news.assigneeMode,
        individualStudentsOptions: news.individualStudentsOptions,
        scheduledTime: news.scheduledTime,
        materials: news.materials,
      };

      let current =
        announcementId !== undefined
          ? yield* getById(courseId, announcementId)
          : undefined;
      if (current === undefined) {
        current = yield* findOwned(courseId, id);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesAnnouncements({
            courseId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(courseId, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesAnnouncementNotResolved({
          courseId,
          announcementId: announcementId ?? "",
        });
      }

      const currentId = current.id ?? announcementId ?? "";
      const textChanged = (current.text ?? "") !== text;
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;
      const scheduledChanged = !sameText(
        current.scheduledTime,
        news.scheduledTime,
      );
      const updateMask = updateMaskOf(
        textChanged ? "text" : undefined,
        stateChanged ? "state" : undefined,
        scheduledChanged ? "scheduled_time" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* classroom.patchCoursesAnnouncements({
          courseId,
          id: currentId,
          updateMask,
          body: {
            text,
            state: news.state,
            scheduledTime: news.scheduledTime,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.courseId.length === 0 || output.announcementId.length === 0) {
        return;
      }
      yield* classroom
        .deleteCoursesAnnouncements({
          courseId: output.courseId,
          id: output.announcementId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
