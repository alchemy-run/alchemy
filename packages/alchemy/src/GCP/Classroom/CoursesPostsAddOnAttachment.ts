import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  listCourses,
  MAX_ATTACHMENT_TITLE_LENGTH,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type ClassroomDate = {
  /** Year (1-9999), or 0 when omitted. */
  year?: number;
  /** Month (1-12), or 0 when omitted. */
  month?: number;
  /** Day of month (1-31), or 0 when omitted. */
  day?: number;
};

export type ClassroomTimeOfDay = {
  /** Hours (0-23, or 24 for end-of-day). */
  hours?: number;
  /** Minutes (0-59). */
  minutes?: number;
  /** Seconds (0-59, or 60 for leap seconds). */
  seconds?: number;
  /** Nanoseconds (0-999999999). */
  nanos?: number;
};

export type ClassroomEmbedUri = {
  /** URI opened in an iframe after Classroom fills query parameters. */
  uri?: string;
};

export type CoursesPostsAddOnAttachmentCopyHistory = {
  /** Course that held the previous copy. */
  courseId?: string;
  /** Previous attachment id. */
  attachmentId?: string;
  /** Previous post id. */
  itemId?: string;
  /** Deprecated post id. */
  postId?: string;
};

export type CoursesPostsAddOnAttachmentProps = {
  /**
   * Identifier of the parent course. Immutable — changing it replaces
   * the attachment.
   */
  courseId: string;
  /**
   * Identifier of the parent `Announcement`, `CourseWork`, or
   * `CourseWorkMaterial` (the `{postId}` path segment). Immutable —
   * changing it replaces the attachment.
   */
  postId: string;
  /**
   * Identifier of the parent item. Defaults to `postId` when omitted.
   * Immutable — changing it replaces the attachment.
   */
  itemId?: string;
  /**
   * Classroom-assigned attachment id. Server-assigned on create.
   * Immutable — changing it replaces the attachment.
   */
  attachmentId?: string;
  /**
   * Token Classroom passes when the user is redirected from an add-on.
   * Required for in-Classroom creation; optional for partner-first
   * creation.
   */
  addOnToken?: string;
  /**
   * Attachment title (1-1000 characters including Alchemy's ownership
   * marker). Add-on attachments have no labels field, so ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  title?: string;
  /**
   * URI of the student view iframe. Required on create.
   */
  studentViewUri: ClassroomEmbedUri;
  /**
   * URI of the teacher view iframe. Required on create.
   */
  teacherViewUri: ClassroomEmbedUri;
  /**
   * URI of the teacher review iframe for student work. Clearing this
   * also discards `maxPoints`.
   */
  studentWorkReviewUri?: ClassroomEmbedUri;
  /**
   * Due date in UTC. Required when `dueTime` is set.
   */
  dueDate?: ClassroomDate;
  /**
   * Due time of day in UTC. Required when `dueDate` is set.
   */
  dueTime?: ClassroomTimeOfDay;
  /**
   * Maximum grade. Only valid when `studentWorkReviewUri` is set. Zero
   * disables grade passback.
   */
  maxPoints?: number;
};

export type CoursesPostsAddOnAttachment = Resource<
  "GCP.Classroom.CoursesPostsAddOnAttachment",
  CoursesPostsAddOnAttachmentProps,
  {
    /** Classroom-assigned attachment id. */
    attachmentId: string;
    /** Parent course id. */
    courseId: string;
    /** Parent post id. */
    postId: string;
    /** Parent item id. */
    itemId: string | undefined;
    /** Project id used when the attachment was reconciled. */
    project: string;
    /** User-facing title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Student view URI. */
    studentViewUri: ClassroomEmbedUri | undefined;
    /** Teacher view URI. */
    teacherViewUri: ClassroomEmbedUri | undefined;
    /** Student-work review URI. */
    studentWorkReviewUri: ClassroomEmbedUri | undefined;
    /** Due date. */
    dueDate: ClassroomDate | undefined;
    /** Due time. */
    dueTime: ClassroomTimeOfDay | undefined;
    /** Maximum grade. */
    maxPoints: number | undefined;
    /** Previous copies of this attachment. */
    copyHistory: CoursesPostsAddOnAttachmentCopyHistory[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Classroom add-on attachment under a course post
 * (announcement, course work, or material).
 *
 * Add-on attachments have no labels field, so Alchemy stamps ownership
 * into `title` for `list` / nuke. Parent course and post are immutable.
 * Title, view URIs, due date/time, and max points update in place.
 *
 * ### Creating an Add-on Attachment
 * **Example:** Partner-first attachment on an announcement
 * ```typescript
 * const attachment = yield* GCP.Classroom.CoursesPostsAddOnAttachment(
 *   "Lab",
 *   {
 *     courseId: course.id,
 *     postId: announcement.id,
 *     title: "Lab notebook",
 *     studentViewUri: { uri: "https://example.com/student" },
 *     teacherViewUri: { uri: "https://example.com/teacher" },
 *   },
 * );
 * ```
 *
 * ### Updating an Add-on Attachment
 * **Example:** Change the title
 * ```typescript
 * const attachment = yield* GCP.Classroom.CoursesPostsAddOnAttachment(
 *   "Lab",
 *   {
 *     courseId: existing.courseId,
 *     postId: existing.postId,
 *     attachmentId: existing.attachmentId,
 *     title: "Lab notebook v2",
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
export const CoursesPostsAddOnAttachment =
  Resource<CoursesPostsAddOnAttachment>(
    "GCP.Classroom.CoursesPostsAddOnAttachment",
  );

export class CoursesPostsAddOnAttachmentNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesPostsAddOnAttachmentNotResolved",
)<{
  courseId: string;
  postId: string;
  attachmentId: string;
}> {}

const uriOf = (
  value: ClassroomEmbedUri | undefined,
): ClassroomEmbedUri | undefined =>
  value?.uri !== undefined ? { uri: value.uri } : undefined;

const dateOf = (
  value: classroom.Classroom_Date | undefined,
): ClassroomDate | undefined => {
  if (value === undefined) return undefined;
  return { year: value.year, month: value.month, day: value.day };
};

const timeOf = (
  value: classroom.TimeOfDay | undefined,
): ClassroomTimeOfDay | undefined => {
  if (value === undefined) return undefined;
  return {
    hours: value.hours,
    minutes: value.minutes,
    seconds: value.seconds,
    nanos: value.nanos,
  };
};

const historyOf = (
  history: classroom.CopyHistoryList | undefined,
): CoursesPostsAddOnAttachmentCopyHistory[] | undefined => {
  if (history === undefined) return undefined;
  return history.map((entry) => ({
    courseId: entry.courseId,
    attachmentId: entry.attachmentId,
    itemId: entry.itemId,
    postId: entry.postId,
  }));
};

const toAttrs = (
  attachment: classroom.AddOnAttachment,
  project: string,
  postIdHint?: string,
) => ({
  attachmentId: attachment.id ?? "",
  courseId: attachment.courseId ?? "",
  postId: attachment.postId ?? postIdHint ?? attachment.itemId ?? "",
  itemId: attachment.itemId,
  project,
  title: parseOwnership(attachment.title).text,
  studentViewUri: uriOf(attachment.studentViewUri),
  teacherViewUri: uriOf(attachment.teacherViewUri),
  studentWorkReviewUri: uriOf(attachment.studentWorkReviewUri),
  dueDate: dateOf(attachment.dueDate),
  dueTime: timeOf(attachment.dueTime),
  maxPoints: attachment.maxPoints,
  copyHistory: historyOf(attachment.copyHistory),
});

const getById = (
  courseId: string,
  postId: string,
  attachmentId: string,
  itemId?: string,
) =>
  courseId.length === 0 || postId.length === 0 || attachmentId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesPostsAddOnAttachments({
          courseId,
          postId,
          attachmentId,
          itemId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtPost = (
  courseId: string,
  postId: string,
  project: string,
  itemId?: string,
) =>
  classroom.listCoursesPostsAddOnAttachments
    .pages({ courseId, postId, itemId, pageSize: 20 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.addOnAttachments ?? []),
      ),
      Stream.filter((attachment) => hasOwnershipMarker(attachment.title)),
      Stream.map((attachment) => toAttrs(attachment, project, postId)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findByTitle = (
  courseId: string,
  postId: string,
  title: string,
  itemId?: string,
) =>
  classroom.listCoursesPostsAddOnAttachments
    .pages({ courseId, postId, itemId, pageSize: 20 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.addOnAttachments ?? []),
      ),
      Stream.filter((attachment) => attachment.title === title),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    );

const listPostIds = (courseId: string) =>
  Effect.gen(function* () {
    const announcements = yield* classroom.listCoursesAnnouncements
      .pages({
        courseId,
        pageSize: 100,
        announcementStates: ["PUBLISHED", "DRAFT"],
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.announcements ?? [])),
        Stream.map((item) => item.id),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
        Effect.catchTag("Forbidden", () => Effect.succeed([] as string[])),
      );
    const courseWork = yield* classroom.listCoursesCourseWork
      .pages({
        courseId,
        pageSize: 100,
        courseWorkStates: ["PUBLISHED", "DRAFT"],
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.courseWork ?? [])),
        Stream.map((item) => item.id),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
        Effect.catchTag("Forbidden", () => Effect.succeed([] as string[])),
      );
    const materials = yield* classroom.listCoursesCourseWorkMaterials
      .pages({
        courseId,
        pageSize: 100,
        courseWorkMaterialStates: ["PUBLISHED", "DRAFT"],
      })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.courseWorkMaterial ?? []),
        ),
        Stream.map((item) => item.id),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
        Effect.catchTag("Forbidden", () => Effect.succeed([] as string[])),
      );
    return [...announcements, ...courseWork, ...materials].filter(
      (id): id is string => id !== undefined && id.length > 0,
    );
  });

export const CoursesPostsAddOnAttachmentProvider = () =>
  Provider.succeed(CoursesPostsAddOnAttachment, {
    stables: ["attachmentId", "courseId", "postId", "itemId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousPost = olds?.postId ?? output?.postId;
      if (previousPost !== undefined && news.postId !== previousPost) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousItem = olds?.itemId ?? output?.itemId;
      if (
        news.itemId !== undefined &&
        previousItem !== undefined &&
        news.itemId !== previousItem
      ) {
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
      const env = yield* GcpEnvironment.current;
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const postId = olds?.postId ?? output?.postId ?? "";
      const itemId = olds?.itemId ?? output?.itemId ?? postId;
      const attachmentId = olds?.attachmentId ?? output?.attachmentId ?? "";
      let existing = yield* getById(courseId, postId, attachmentId, itemId);
      if (existing === undefined && courseId.length > 0 && postId.length > 0) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByTitle(
          courseId,
          postId,
          encodeOwnershipLine(
            ownership,
            olds?.title ?? output?.title,
            MAX_ATTACHMENT_TITLE_LENGTH,
          ),
          itemId,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, postId);
      return (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const courses = yield* listCourses();
        const pages = yield* Effect.forEach(
          courses,
          (course) =>
            course.id === undefined
              ? Effect.succeed([])
              : Effect.gen(function* () {
                  const postIds = yield* listPostIds(course.id!);
                  const attachments = yield* Effect.forEach(
                    postIds,
                    (postId) =>
                      listAtPost(course.id!, postId, env.project, postId),
                    { concurrency: 4 },
                  );
                  return attachments.flat();
                }),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const courseId = news.courseId;
      const postId = news.postId;
      const itemId = news.itemId ?? postId;
      const attachmentId = news.attachmentId ?? output?.attachmentId ?? "";
      const ownership = yield* createInternalLabels(id);
      const title = encodeOwnershipLine(
        ownership,
        news.title,
        MAX_ATTACHMENT_TITLE_LENGTH,
      );
      const studentViewUri = uriOf(news.studentViewUri);
      const teacherViewUri = uriOf(news.teacherViewUri);
      const studentWorkReviewUri = uriOf(news.studentWorkReviewUri);

      let current = yield* getById(courseId, postId, attachmentId, itemId);
      if (current === undefined) {
        current = yield* findByTitle(courseId, postId, title, itemId);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesPostsAddOnAttachments({
            courseId,
            postId,
            itemId,
            addOnToken: news.addOnToken,
            body: {
              title,
              studentViewUri,
              teacherViewUri,
              studentWorkReviewUri,
              dueDate: news.dueDate,
              dueTime: news.dueTime,
              maxPoints: news.maxPoints,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByTitle(courseId, postId, title, itemId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesPostsAddOnAttachmentNotResolved({
          courseId,
          postId,
          attachmentId: attachmentId || title,
        });
      }

      const currentId = current.id ?? attachmentId;
      const titleChanged = !sameText(current.title, title);
      const studentViewChanged = !jsonEqual(
        uriOf(current.studentViewUri),
        studentViewUri,
      );
      const teacherViewChanged = !jsonEqual(
        uriOf(current.teacherViewUri),
        teacherViewUri,
      );
      const reviewChanged = !jsonEqual(
        uriOf(current.studentWorkReviewUri),
        studentWorkReviewUri,
      );
      const dueDateChanged = !jsonEqual(dateOf(current.dueDate), news.dueDate);
      const dueTimeChanged = !jsonEqual(timeOf(current.dueTime), news.dueTime);
      const maxPointsChanged =
        (current.maxPoints ?? 0) !== (news.maxPoints ?? 0);

      if (
        titleChanged ||
        studentViewChanged ||
        teacherViewChanged ||
        reviewChanged ||
        dueDateChanged ||
        dueTimeChanged ||
        maxPointsChanged
      ) {
        current = yield* classroom.patchCoursesPostsAddOnAttachments({
          courseId,
          postId,
          attachmentId: currentId,
          itemId,
          updateMask: updateMaskOf(
            titleChanged ? "title" : undefined,
            studentViewChanged ? "student_view_uri" : undefined,
            teacherViewChanged ? "teacher_view_uri" : undefined,
            reviewChanged ? "student_work_review_uri" : undefined,
            dueDateChanged ? "due_date" : undefined,
            dueTimeChanged ? "due_time" : undefined,
            maxPointsChanged ? "max_points" : undefined,
          ),
          body: {
            title,
            studentViewUri,
            teacherViewUri,
            studentWorkReviewUri,
            dueDate: news.dueDate,
            dueTime: news.dueTime,
            maxPoints: news.maxPoints,
          },
        });
      }

      return toAttrs(current, env.project, postId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        output.courseId.length === 0 ||
        output.postId.length === 0 ||
        output.attachmentId.length === 0
      ) {
        return;
      }
      yield* classroom
        .deleteCoursesPostsAddOnAttachments({
          courseId: output.courseId,
          postId: output.postId,
          attachmentId: output.attachmentId,
          itemId: output.itemId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
