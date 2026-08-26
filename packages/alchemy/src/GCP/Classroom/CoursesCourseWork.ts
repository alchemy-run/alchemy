import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  type ClassroomDate,
  courseIdsOf,
  encodeOwnership,
  hasOwnershipMarker,
  individualStudentsOf,
  type IndividualStudentsOptions,
  listCourseWork,
  listOwnedCourses,
  type Material,
  materialsOf,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameJson,
  sameNumber,
  sameText,
  type TimeOfDay,
  updateMaskOf,
} from "./internal.ts";

export type MultipleChoiceQuestion = {
  /** Choices presented to the student. */
  choices?: string[];
};

export type CoursesCourseWorkProps = {
  /**
   * Parent course id (Classroom-assigned id or alias). Immutable —
   * changing it replaces the course work.
   */
  courseId: string;
  /**
   * Classroom-assigned course work id. Server-assigned on create.
   * Immutable — changing it replaces the course work.
   */
  courseWorkId?: string;
  /**
   * Title (1-3000 characters).
   */
  title?: string;
  /**
   * Description. Classroom course work has no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes. Max 30,000 characters including the prefix.
   */
  description?: string;
  /**
   * Work type. Set on create and cannot change. Changing it replaces
   * the course work.
   * @default "ASSIGNMENT"
   */
  workType?: classroom.CourseWorkWorkTypeEnum | (string & {});
  /**
   * Course work state. Unspecified defaults to `DRAFT`.
   */
  state?: classroom.CourseWorkStateEnum | (string & {});
  /**
   * Assignee mode. Unspecified defaults to `ALL_STUDENTS`.
   */
  assigneeMode?: classroom.CourseWorkAssigneeModeEnum | (string & {});
  /**
   * Students with access when `assigneeMode` is `INDIVIDUAL_STUDENTS`.
   */
  individualStudentsOptions?: IndividualStudentsOptions;
  /**
   * Maximum grade. Zero or omitted means ungraded.
   */
  maxPoints?: number;
  /**
   * Due date in UTC. Required when `dueTime` is set.
   */
  dueDate?: ClassroomDate;
  /**
   * Due time in UTC. Required when `dueDate` is set.
   */
  dueTime?: TimeOfDay;
  /**
   * Optional RFC3339 timestamp when this course work is scheduled to
   * be published.
   */
  scheduledTime?: string;
  /**
   * Topic id in the parent course.
   */
  topicId?: string;
  /**
   * Grading period id. Empty string clears the association.
   */
  gradingPeriodId?: string;
  /**
   * When students may modify submissions.
   */
  submissionModificationMode?:
    | classroom.CourseWorkSubmissionModificationModeEnum
    | (string & {});
  /**
   * Multiple-choice details. Required when `workType` is
   * `MULTIPLE_CHOICE_QUESTION`.
   */
  multipleChoiceQuestion?: MultipleChoiceQuestion;
  /**
   * Additional materials (max 20).
   */
  materials?: Material[];
};

export type CoursesCourseWork = Resource<
  "GCP.Classroom.CoursesCourseWork",
  CoursesCourseWorkProps,
  {
    /** Classroom-assigned course work id. */
    courseWorkId: string;
    /** Parent course id. */
    courseId: string;
    /** Title. */
    title: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Work type. */
    workType: string | undefined;
    /** Course work state. */
    state: string | undefined;
    /** Assignee mode. */
    assigneeMode: string | undefined;
    /** Individual-student options. */
    individualStudentsOptions: IndividualStudentsOptions | undefined;
    /** Maximum grade. */
    maxPoints: number | undefined;
    /** Due date. */
    dueDate: ClassroomDate | undefined;
    /** Due time. */
    dueTime: TimeOfDay | undefined;
    /** Scheduled publish time. */
    scheduledTime: string | undefined;
    /** Topic id. */
    topicId: string | undefined;
    /** Grading period id. */
    gradingPeriodId: string | undefined;
    /** Submission modification mode. */
    submissionModificationMode: string | undefined;
    /** Multiple-choice details. */
    multipleChoiceQuestion: MultipleChoiceQuestion | undefined;
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
 * Google Classroom course work (assignment, short answer, or multiple
 * choice).
 *
 * Alchemy stamps ownership into `description` for `list` / nuke. Parent
 * course, course work id, and `workType` are identity. Title,
 * description, state, due date, points, topic, and schedule update in
 * place.
 *
 * ### Creating Course Work
 * **Example:** Draft assignment
 * ```typescript
 * const work = yield* GCP.Classroom.CoursesCourseWork("Homework", {
 *   courseId: course.courseId,
 *   title: "Week 1 homework",
 *   description: "read chapter 1",
 *   workType: "ASSIGNMENT",
 *   state: "DRAFT",
 *   maxPoints: 10,
 * });
 * ```
 *
 * ### Updating Course Work
 * **Example:** Change the title and points
 * ```typescript
 * const work = yield* GCP.Classroom.CoursesCourseWork("Homework", {
 *   courseId: existing.courseId,
 *   courseWorkId: existing.courseWorkId,
 *   title: "Week 1 homework",
 *   description: "read chapters 1-2",
 *   workType: "ASSIGNMENT",
 *   state: "DRAFT",
 *   maxPoints: 20,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesCourseWork = Resource<CoursesCourseWork>(
  "GCP.Classroom.CoursesCourseWork",
);

export class CoursesCourseWorkNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesCourseWorkNotResolved",
)<{
  courseId: string;
  courseWorkId: string;
}> {}

const DEFAULT_WORK_TYPE = "ASSIGNMENT";

const getById = (courseId: string, id: string) =>
  courseId.length === 0 || id.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesCourseWork({ courseId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (work: classroom.CourseWork) => {
  const parsed = parseOwnership(work.description);
  return {
    courseWorkId: work.id ?? "",
    courseId: work.courseId ?? "",
    title: work.title,
    description: parsed.text,
    workType: work.workType,
    state: work.state,
    assigneeMode: work.assigneeMode,
    individualStudentsOptions: individualStudentsOf(
      work.individualStudentsOptions,
    ),
    maxPoints: work.maxPoints,
    dueDate: work.dueDate,
    dueTime: work.dueTime,
    scheduledTime: work.scheduledTime,
    topicId: work.topicId,
    gradingPeriodId: work.gradingPeriodId,
    submissionModificationMode: work.submissionModificationMode,
    multipleChoiceQuestion: work.multipleChoiceQuestion,
    materials: materialsOf(work.materials),
    creatorUserId: work.creatorUserId,
    alternateLink: work.alternateLink,
    creationTime: work.creationTime,
    updateTime: work.updateTime,
  };
};

const findOwned = (courseId: string, id: string) =>
  Effect.gen(function* () {
    const items = yield* listCourseWork(courseId);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.description)) {
        return item;
      }
    }
    return undefined;
  });

export const CoursesCourseWorkProvider = () =>
  Provider.succeed(CoursesCourseWork, {
    stables: ["courseWorkId", "courseId", "workType", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.courseWorkId ?? output?.courseWorkId;
      if (
        previousId !== undefined &&
        news.courseWorkId !== undefined &&
        news.courseWorkId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.workType ?? output?.workType;
      const nextType = news.workType ?? DEFAULT_WORK_TYPE;
      if (previousType !== undefined && previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const courseWorkId = olds?.courseWorkId ?? output?.courseWorkId;
      let existing =
        courseWorkId !== undefined
          ? yield* getById(courseId, courseWorkId)
          : undefined;
      if (existing === undefined) {
        existing = yield* findOwned(courseId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const courses = yield* listOwnedCourses();
        const pages = yield* Effect.forEach(
          courseIdsOf(courses),
          (courseId) => listCourseWork(courseId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const courseId = news.courseId;
      const courseWorkId = news.courseWorkId ?? output?.courseWorkId;
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const workType = news.workType ?? DEFAULT_WORK_TYPE;
      const body: classroom.CourseWork = {
        title: news.title,
        description,
        workType,
        state: news.state,
        assigneeMode: news.assigneeMode,
        individualStudentsOptions: news.individualStudentsOptions,
        maxPoints: news.maxPoints,
        dueDate: news.dueDate,
        dueTime: news.dueTime,
        scheduledTime: news.scheduledTime,
        topicId: news.topicId,
        gradingPeriodId: news.gradingPeriodId,
        submissionModificationMode: news.submissionModificationMode,
        multipleChoiceQuestion: news.multipleChoiceQuestion,
        materials: news.materials,
      };

      let current =
        courseWorkId !== undefined
          ? yield* getById(courseId, courseWorkId)
          : undefined;
      if (current === undefined) {
        current = yield* findOwned(courseId, id);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesCourseWork({
            courseId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(courseId, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesCourseWorkNotResolved({
          courseId,
          courseWorkId: courseWorkId ?? "",
        });
      }

      const currentId = current.id ?? courseWorkId ?? "";
      const titleChanged = !sameText(current.title, news.title);
      const descriptionChanged = (current.description ?? "") !== description;
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;
      const dueDateChanged = !sameJson(current.dueDate, news.dueDate);
      const dueTimeChanged = !sameJson(current.dueTime, news.dueTime);
      const pointsChanged = !sameNumber(current.maxPoints, news.maxPoints);
      const scheduledChanged = !sameText(
        current.scheduledTime,
        news.scheduledTime,
      );
      const topicChanged = !sameText(current.topicId, news.topicId);
      const periodChanged = !sameText(
        current.gradingPeriodId,
        news.gradingPeriodId,
      );
      const modeChanged = !sameText(
        current.submissionModificationMode,
        news.submissionModificationMode,
      );

      const updateMask = updateMaskOf(
        titleChanged ? "title" : undefined,
        descriptionChanged ? "description" : undefined,
        stateChanged ? "state" : undefined,
        dueDateChanged ? "due_date" : undefined,
        dueTimeChanged ? "due_time" : undefined,
        pointsChanged ? "max_points" : undefined,
        scheduledChanged ? "scheduled_time" : undefined,
        topicChanged ? "topic_id" : undefined,
        periodChanged ? "grading_period_id" : undefined,
        modeChanged ? "submission_modification_mode" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* classroom.patchCoursesCourseWork({
          courseId,
          id: currentId,
          updateMask,
          body: {
            title: news.title,
            description,
            state: news.state,
            dueDate: news.dueDate,
            dueTime: news.dueTime,
            maxPoints: news.maxPoints,
            scheduledTime: news.scheduledTime,
            topicId: news.topicId,
            gradingPeriodId: news.gradingPeriodId,
            submissionModificationMode: news.submissionModificationMode,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.courseId.length === 0 || output.courseWorkId.length === 0) {
        return;
      }
      yield* classroom
        .deleteCoursesCourseWork({
          courseId: output.courseId,
          id: output.courseWorkId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
