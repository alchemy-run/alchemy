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
  criteriaOf,
  hasOwnershipMarker,
  listCourseWork,
  listOwnedCourses,
  listRubrics,
  ownedByAlchemy,
  ownershipLabels,
  type RubricCriterion,
  rubricOwnershipText,
  sameJson,
  sameText,
  stampCriteria,
  updateMaskOf,
} from "./internal.ts";

export type CoursesCourseWorkRubricProps = {
  /**
   * Parent course id. Immutable — changing it replaces the rubric.
   */
  courseId: string;
  /**
   * Parent course work id. Immutable — changing it replaces the rubric.
   */
  courseWorkId: string;
  /**
   * Classroom-assigned rubric id. Server-assigned on create. Immutable
   * — changing it replaces the rubric.
   */
  rubricId?: string;
  /**
   * Rubric criteria. Classroom rubrics have no labels field, so Alchemy
   * ownership is stored in the first criterion description and stripped
   * from attributes. Mutually exclusive with `sourceSpreadsheetId`.
   */
  criteria?: RubricCriterion[];
  /**
   * Google Sheets id of a formatted rubric spreadsheet. Mutually
   * exclusive with `criteria`. Requires spreadsheets scope.
   */
  sourceSpreadsheetId?: string;
};

export type CoursesCourseWorkRubric = Resource<
  "GCP.Classroom.CoursesCourseWorkRubric",
  CoursesCourseWorkRubricProps,
  {
    /** Classroom-assigned rubric id. */
    rubricId: string;
    /** Parent course id. */
    courseId: string;
    /** Parent course work id. */
    courseWorkId: string;
    /** Criteria with the Alchemy ownership prefix stripped. */
    criteria: RubricCriterion[] | undefined;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A scoring rubric on Classroom course work.
 *
 * Creating a rubric requires Classroom rubrics licensing. Alchemy
 * stamps ownership into the first criterion description for `list` /
 * nuke. Parent course, course work, and rubric id are identity.
 * Criteria update in place (full replace).
 *
 * ### Creating a Rubric
 * **Example:** Single-criterion rubric
 * ```typescript
 * const rubric = yield* GCP.Classroom.CoursesCourseWorkRubric("Scale", {
 *   courseId: course.courseId,
 *   courseWorkId: work.courseWorkId,
 *   criteria: [
 *     {
 *       title: "Quality",
 *       description: "overall quality",
 *       levels: [
 *         { title: "Meets", points: 1 },
 *         { title: "Exceeds", points: 2 },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Updating a Rubric
 * **Example:** Change a level title
 * ```typescript
 * const rubric = yield* GCP.Classroom.CoursesCourseWorkRubric("Scale", {
 *   courseId: existing.courseId,
 *   courseWorkId: existing.courseWorkId,
 *   rubricId: existing.rubricId,
 *   criteria: [
 *     {
 *       title: "Quality",
 *       description: "overall quality",
 *       levels: [
 *         { title: "Developing", points: 1 },
 *         { title: "Exceeds", points: 2 },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesCourseWorkRubric = Resource<CoursesCourseWorkRubric>(
  "GCP.Classroom.CoursesCourseWorkRubric",
);

export class CoursesCourseWorkRubricNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesCourseWorkRubricNotResolved",
)<{
  courseId: string;
  courseWorkId: string;
  rubricId: string;
}> {}

const getById = (courseId: string, courseWorkId: string, id: string) =>
  courseId.length === 0 || courseWorkId.length === 0 || id.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesCourseWorkRubrics({ courseId, courseWorkId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (rubric: classroom.Rubric) => ({
  rubricId: rubric.id ?? "",
  courseId: rubric.courseId ?? "",
  courseWorkId: rubric.courseWorkId ?? "",
  criteria: criteriaOf(rubric.criteria),
  creationTime: rubric.creationTime,
  updateTime: rubric.updateTime,
});

const findOwned = (courseId: string, courseWorkId: string, id: string) =>
  Effect.gen(function* () {
    const items = yield* listRubrics(courseId, courseWorkId);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, rubricOwnershipText(item))) {
        return item;
      }
    }
    return undefined;
  });

export const CoursesCourseWorkRubricProvider = () =>
  Provider.succeed(CoursesCourseWorkRubric, {
    stables: ["rubricId", "courseId", "courseWorkId", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousWork = olds?.courseWorkId ?? output?.courseWorkId;
      if (previousWork !== undefined && news.courseWorkId !== previousWork) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.rubricId ?? output?.rubricId;
      if (
        previousId !== undefined &&
        news.rubricId !== undefined &&
        news.rubricId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const courseWorkId = olds?.courseWorkId ?? output?.courseWorkId ?? "";
      const rubricId = olds?.rubricId ?? output?.rubricId;
      let existing =
        rubricId !== undefined
          ? yield* getById(courseId, courseWorkId, rubricId)
          : undefined;
      if (existing === undefined) {
        existing = yield* findOwned(courseId, courseWorkId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, rubricOwnershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const courses = yield* listOwnedCourses();
        const rubrics = yield* Effect.forEach(
          courseIdsOf(courses),
          (courseId) =>
            Effect.gen(function* () {
              const work = yield* listCourseWork(courseId);
              const nested = yield* Effect.forEach(
                work.flatMap((item) =>
                  item.id !== undefined && item.id.length > 0 ? [item.id] : [],
                ),
                (courseWorkId) => listRubrics(courseId, courseWorkId),
                { concurrency: 2 },
              );
              return nested.flat();
            }),
          { concurrency: 2 },
        );
        return rubrics
          .flat()
          .filter((item) => hasOwnershipMarker(rubricOwnershipText(item)))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const courseId = news.courseId;
      const courseWorkId = news.courseWorkId;
      const rubricId = news.rubricId ?? output?.rubricId;
      const ownership = yield* ownershipLabels(id);
      const criteria = stampCriteria(ownership, news.criteria);
      const body: classroom.Rubric = {
        criteria,
        sourceSpreadsheetId: news.sourceSpreadsheetId,
      };

      let current =
        rubricId !== undefined
          ? yield* getById(courseId, courseWorkId, rubricId)
          : undefined;
      if (current === undefined) {
        current = yield* findOwned(courseId, courseWorkId, id);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesCourseWorkRubrics({
            courseId,
            courseWorkId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(courseId, courseWorkId, id),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesCourseWorkRubricNotResolved({
          courseId,
          courseWorkId,
          rubricId: rubricId ?? "",
        });
      }

      const currentId = current.id ?? rubricId ?? "";
      const criteriaChanged = !sameJson(
        stampCriteria(ownership, criteriaOf(current.criteria)),
        criteria,
      );
      const spreadsheetChanged = !sameText(
        current.sourceSpreadsheetId,
        news.sourceSpreadsheetId,
      );

      const updateMask = updateMaskOf(
        criteriaChanged && news.sourceSpreadsheetId === undefined
          ? "criteria"
          : undefined,
        spreadsheetChanged && news.sourceSpreadsheetId !== undefined
          ? "source_spreadsheet_id"
          : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* classroom.patchCoursesCourseWorkRubrics({
          courseId,
          courseWorkId,
          id: currentId,
          updateMask,
          body,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        output.courseId.length === 0 ||
        output.courseWorkId.length === 0 ||
        output.rubricId.length === 0
      ) {
        return;
      }
      yield* classroom
        .deleteCoursesCourseWorkRubrics({
          courseId: output.courseId,
          courseWorkId: output.courseWorkId,
          id: output.rubricId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
