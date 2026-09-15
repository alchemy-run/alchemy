import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  type AddOnAttachmentBody,
  addOnAttachmentOf,
  type ClassroomDate,
  type CopyHistory,
  courseIdsOf,
  desiredAddOnTitle,
  type EmbedUri,
  hasOwnershipMarker,
  listCourseWork,
  listCourseWorkAddOnAttachments,
  listOwnedCourses,
  ownedByAlchemy,
  ownershipLabels,
  sameJson,
  sameNumber,
  type TimeOfDay,
  updateMaskOf,
} from "./internal.ts";

export type CoursesCourseWorkAddOnAttachmentProps = AddOnAttachmentBody & {
  /**
   * Parent course id. Immutable — changing it replaces the attachment.
   */
  courseId: string;
  /**
   * Parent course work id (`itemId`). Immutable — changing it replaces
   * the attachment.
   */
  itemId: string;
  /**
   * Classroom-assigned attachment id. Server-assigned on create.
   * Immutable — changing it replaces the attachment.
   */
  attachmentId?: string;
  /**
   * Add-on authorization token from the Classroom iframe redirect.
   * Required for in-Classroom creation; optional for partner-first
   * creation.
   */
  addOnToken?: string;
};

export type CoursesCourseWorkAddOnAttachment = Resource<
  "GCP.Classroom.CoursesCourseWorkAddOnAttachment",
  CoursesCourseWorkAddOnAttachmentProps,
  {
    /** Classroom-assigned attachment id. */
    attachmentId: string;
    /** Parent course id. */
    courseId: string;
    /** Parent course work id. */
    itemId: string;
    /** User title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Student iframe URI. */
    studentViewUri: EmbedUri | undefined;
    /** Teacher iframe URI. */
    teacherViewUri: EmbedUri | undefined;
    /** Student-work review URI. */
    studentWorkReviewUri: EmbedUri | undefined;
    /** Due date. */
    dueDate: ClassroomDate | undefined;
    /** Due time. */
    dueTime: TimeOfDay | undefined;
    /** Maximum grade. */
    maxPoints: number | undefined;
    /** Previous copy identifiers. */
    copyHistory: CopyHistory[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Classroom add-on attachment on course work.
 *
 * Creating an attachment requires the calling project to be a Classroom
 * add-on. Alchemy stamps ownership into `title` for `list` / nuke.
 * Parent course, course work, and attachment id are identity. Title,
 * view URIs, due date, and points update in place.
 *
 * ### Creating an Add-On Attachment
 * **Example:** Partner-first attachment
 * ```typescript
 * const attachment = yield* GCP.Classroom.CoursesCourseWorkAddOnAttachment(
 *   "Lab",
 *   {
 *     courseId: course.courseId,
 *     itemId: work.courseWorkId,
 *     title: "Virtual lab",
 *     studentViewUri: { uri: "https://example.com/student" },
 *     teacherViewUri: { uri: "https://example.com/teacher" },
 *   },
 * );
 * ```
 *
 * ### Updating an Add-On Attachment
 * **Example:** Change the title
 * ```typescript
 * const attachment = yield* GCP.Classroom.CoursesCourseWorkAddOnAttachment(
 *   "Lab",
 *   {
 *     courseId: existing.courseId,
 *     itemId: existing.itemId,
 *     attachmentId: existing.attachmentId,
 *     title: "Virtual lab v2",
 *     studentViewUri: { uri: "https://example.com/student" },
 *     teacherViewUri: { uri: "https://example.com/teacher" },
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesCourseWorkAddOnAttachment =
  Resource<CoursesCourseWorkAddOnAttachment>(
    "GCP.Classroom.CoursesCourseWorkAddOnAttachment",
  );

export class CoursesCourseWorkAddOnAttachmentNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesCourseWorkAddOnAttachmentNotResolved",
)<{
  courseId: string;
  itemId: string;
  attachmentId: string;
}> {}

const getById = (courseId: string, itemId: string, attachmentId: string) =>
  courseId.length === 0 || itemId.length === 0 || attachmentId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesCourseWorkAddOnAttachments({
          courseId,
          itemId,
          attachmentId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (attachment: classroom.AddOnAttachment) => {
  const mapped = addOnAttachmentOf(attachment);
  return {
    attachmentId: mapped.id,
    courseId: mapped.courseId,
    itemId: mapped.itemId,
    title: mapped.title,
    studentViewUri: mapped.studentViewUri,
    teacherViewUri: mapped.teacherViewUri,
    studentWorkReviewUri: mapped.studentWorkReviewUri,
    dueDate: mapped.dueDate,
    dueTime: mapped.dueTime,
    maxPoints: mapped.maxPoints,
    copyHistory: mapped.copyHistory,
  };
};

const findOwned = (courseId: string, itemId: string, id: string) =>
  Effect.gen(function* () {
    const items = yield* listCourseWorkAddOnAttachments(courseId, itemId);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.title)) {
        return item;
      }
    }
    return undefined;
  });

const listOwnedAttachments = () =>
  Effect.gen(function* () {
    const courses = yield* listOwnedCourses();
    const attachments = yield* Effect.forEach(
      courseIdsOf(courses),
      (courseId) =>
        Effect.gen(function* () {
          const posts = yield* listCourseWork(courseId);
          const nested = yield* Effect.forEach(
            posts.flatMap((post) =>
              post.id !== undefined && post.id.length > 0 ? [post.id] : [],
            ),
            (itemId) => listCourseWorkAddOnAttachments(courseId, itemId),
            { concurrency: 2 },
          );
          return nested.flat();
        }),
      { concurrency: 2 },
    );
    return attachments
      .flat()
      .filter((item) => hasOwnershipMarker(item.title))
      .map(toAttrs);
  });

export const CoursesCourseWorkAddOnAttachmentProvider = () =>
  Provider.succeed(CoursesCourseWorkAddOnAttachment, {
    stables: ["attachmentId", "courseId", "itemId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousItem = olds?.itemId ?? output?.itemId;
      if (previousItem !== undefined && news.itemId !== previousItem) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.attachmentId ?? output?.attachmentId;
      if (
        previousId !== undefined &&
        news.attachmentId !== undefined &&
        news.attachmentId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const itemId = olds?.itemId ?? output?.itemId ?? "";
      const attachmentId = olds?.attachmentId ?? output?.attachmentId;
      let existing =
        attachmentId !== undefined
          ? yield* getById(courseId, itemId, attachmentId)
          : undefined;
      if (existing === undefined) {
        existing = yield* findOwned(courseId, itemId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () => listOwnedAttachments(),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const courseId = news.courseId;
      const itemId = news.itemId;
      const attachmentId = news.attachmentId ?? output?.attachmentId;
      const ownership = yield* ownershipLabels(id);
      const title = desiredAddOnTitle(ownership, news.title);
      const body: classroom.AddOnAttachment = {
        title,
        studentViewUri: news.studentViewUri,
        teacherViewUri: news.teacherViewUri,
        studentWorkReviewUri: news.studentWorkReviewUri,
        dueDate: news.dueDate,
        dueTime: news.dueTime,
        maxPoints: news.maxPoints,
      };

      let current =
        attachmentId !== undefined
          ? yield* getById(courseId, itemId, attachmentId)
          : undefined;
      if (current === undefined) {
        current = yield* findOwned(courseId, itemId, id);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesCourseWorkAddOnAttachments({
            courseId,
            itemId,
            addOnToken: news.addOnToken,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwned(courseId, itemId, id)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesCourseWorkAddOnAttachmentNotResolved({
          courseId,
          itemId,
          attachmentId: attachmentId ?? "",
        });
      }

      const currentId = current.id ?? attachmentId ?? "";
      const titleChanged = (current.title ?? "") !== title;
      const studentChanged = !sameJson(
        current.studentViewUri,
        news.studentViewUri,
      );
      const teacherChanged = !sameJson(
        current.teacherViewUri,
        news.teacherViewUri,
      );
      const reviewChanged = !sameJson(
        current.studentWorkReviewUri,
        news.studentWorkReviewUri,
      );
      const dueDateChanged = !sameJson(current.dueDate, news.dueDate);
      const dueTimeChanged = !sameJson(current.dueTime, news.dueTime);
      const pointsChanged = !sameNumber(current.maxPoints, news.maxPoints);

      const updateMask = updateMaskOf(
        titleChanged ? "title" : undefined,
        studentChanged ? "student_view_uri" : undefined,
        teacherChanged ? "teacher_view_uri" : undefined,
        reviewChanged ? "student_work_review_uri" : undefined,
        dueDateChanged ? "due_date" : undefined,
        dueTimeChanged ? "due_time" : undefined,
        pointsChanged ? "max_points" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* classroom.patchCoursesCourseWorkAddOnAttachments({
          courseId,
          itemId,
          attachmentId: currentId,
          updateMask,
          body,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        output.courseId.length === 0 ||
        output.itemId.length === 0 ||
        output.attachmentId.length === 0
      ) {
        return;
      }
      yield* classroom
        .deleteCoursesCourseWorkAddOnAttachments({
          courseId: output.courseId,
          itemId: output.itemId,
          attachmentId: output.attachmentId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
