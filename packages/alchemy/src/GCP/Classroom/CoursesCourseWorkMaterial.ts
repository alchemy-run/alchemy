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
  listCourseWorkMaterials,
  listOwnedCourses,
  type Material,
  materialsOf,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type CoursesCourseWorkMaterialProps = {
  /**
   * Parent course id (Classroom-assigned id or alias). Immutable —
   * changing it replaces the material.
   */
  courseId: string;
  /**
   * Classroom-assigned material id. Server-assigned on create.
   * Immutable — changing it replaces the material.
   */
  courseWorkMaterialId?: string;
  /**
   * Title (1-3000 characters).
   */
  title?: string;
  /**
   * Description. Classroom materials have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes. Max 30,000 characters including the prefix.
   */
  description?: string;
  /**
   * Material state. Unspecified defaults to `DRAFT`.
   */
  state?: classroom.CourseWorkMaterialStateEnum | (string & {});
  /**
   * Assignee mode. Unspecified defaults to `ALL_STUDENTS`.
   */
  assigneeMode?: classroom.CourseWorkMaterialAssigneeModeEnum | (string & {});
  /**
   * Students with access when `assigneeMode` is `INDIVIDUAL_STUDENTS`.
   */
  individualStudentsOptions?: IndividualStudentsOptions;
  /**
   * Topic id in the parent course.
   */
  topicId?: string;
  /**
   * Optional RFC3339 timestamp when this material is scheduled to be
   * published.
   */
  scheduledTime?: string;
  /**
   * Additional materials (max 20).
   */
  materials?: Material[];
};

export type CoursesCourseWorkMaterial = Resource<
  "GCP.Classroom.CoursesCourseWorkMaterial",
  CoursesCourseWorkMaterialProps,
  {
    /** Classroom-assigned material id. */
    courseWorkMaterialId: string;
    /** Parent course id. */
    courseId: string;
    /** Title. */
    title: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Material state. */
    state: string | undefined;
    /** Assignee mode. */
    assigneeMode: string | undefined;
    /** Individual-student options. */
    individualStudentsOptions: IndividualStudentsOptions | undefined;
    /** Topic id. */
    topicId: string | undefined;
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
 * Google Classroom course work material (a resource post, not an
 * assignment).
 *
 * Alchemy stamps ownership into `description` for `list` / nuke. Parent
 * course and material id are identity. Title, description, state,
 * topic, and schedule update in place.
 *
 * ### Creating Course Work Material
 * **Example:** Draft reading
 * ```typescript
 * const material = yield* GCP.Classroom.CoursesCourseWorkMaterial(
 *   "Reading",
 *   {
 *     courseId: course.courseId,
 *     title: "Week 1 reading",
 *     description: "syllabus",
 *     state: "DRAFT",
 *   },
 * );
 * ```
 *
 * ### Updating Course Work Material
 * **Example:** Change the title
 * ```typescript
 * const material = yield* GCP.Classroom.CoursesCourseWorkMaterial(
 *   "Reading",
 *   {
 *     courseId: existing.courseId,
 *     courseWorkMaterialId: existing.courseWorkMaterialId,
 *     title: "Week 1 reading list",
 *     description: "syllabus",
 *     state: "DRAFT",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesCourseWorkMaterial = Resource<CoursesCourseWorkMaterial>(
  "GCP.Classroom.CoursesCourseWorkMaterial",
);

export class CoursesCourseWorkMaterialNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesCourseWorkMaterialNotResolved",
)<{
  courseId: string;
  courseWorkMaterialId: string;
}> {}

const getById = (courseId: string, id: string) =>
  courseId.length === 0 || id.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesCourseWorkMaterials({ courseId, id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (material: classroom.CourseWorkMaterial) => {
  const parsed = parseOwnership(material.description);
  return {
    courseWorkMaterialId: material.id ?? "",
    courseId: material.courseId ?? "",
    title: material.title,
    description: parsed.text,
    state: material.state,
    assigneeMode: material.assigneeMode,
    individualStudentsOptions: individualStudentsOf(
      material.individualStudentsOptions,
    ),
    topicId: material.topicId,
    scheduledTime: material.scheduledTime,
    materials: materialsOf(material.materials),
    creatorUserId: material.creatorUserId,
    alternateLink: material.alternateLink,
    creationTime: material.creationTime,
    updateTime: material.updateTime,
  };
};

const findOwned = (courseId: string, id: string) =>
  Effect.gen(function* () {
    const items = yield* listCourseWorkMaterials(courseId);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.description)) {
        return item;
      }
    }
    return undefined;
  });

export const CoursesCourseWorkMaterialProvider = () =>
  Provider.succeed(CoursesCourseWorkMaterial, {
    stables: ["courseWorkMaterialId", "courseId", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.courseWorkMaterialId ?? output?.courseWorkMaterialId;
      if (
        previousId !== undefined &&
        news.courseWorkMaterialId !== undefined &&
        news.courseWorkMaterialId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const materialId =
        olds?.courseWorkMaterialId ?? output?.courseWorkMaterialId;
      let existing =
        materialId !== undefined
          ? yield* getById(courseId, materialId)
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
          (courseId) => listCourseWorkMaterials(courseId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const courseId = news.courseId;
      const materialId =
        news.courseWorkMaterialId ?? output?.courseWorkMaterialId;
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const body: classroom.CourseWorkMaterial = {
        title: news.title,
        description,
        state: news.state,
        assigneeMode: news.assigneeMode,
        individualStudentsOptions: news.individualStudentsOptions,
        topicId: news.topicId,
        scheduledTime: news.scheduledTime,
        materials: news.materials,
      };

      let current =
        materialId !== undefined
          ? yield* getById(courseId, materialId)
          : undefined;
      if (current === undefined) {
        current = yield* findOwned(courseId, id);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesCourseWorkMaterials({
            courseId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(courseId, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesCourseWorkMaterialNotResolved({
          courseId,
          courseWorkMaterialId: materialId ?? "",
        });
      }

      const currentId = current.id ?? materialId ?? "";
      const titleChanged = !sameText(current.title, news.title);
      const descriptionChanged = (current.description ?? "") !== description;
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;
      const scheduledChanged = !sameText(
        current.scheduledTime,
        news.scheduledTime,
      );
      const topicChanged = !sameText(current.topicId, news.topicId);

      const updateMask = updateMaskOf(
        titleChanged ? "title" : undefined,
        descriptionChanged ? "description" : undefined,
        stateChanged ? "state" : undefined,
        scheduledChanged ? "scheduled_time" : undefined,
        topicChanged ? "topic_id" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* classroom.patchCoursesCourseWorkMaterials({
          courseId,
          id: currentId,
          updateMask,
          body: {
            title: news.title,
            description,
            state: news.state,
            scheduledTime: news.scheduledTime,
            topicId: news.topicId,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        output.courseId.length === 0 ||
        output.courseWorkMaterialId.length === 0
      ) {
        return;
      }
      yield* classroom
        .deleteCoursesCourseWorkMaterials({
          courseId: output.courseId,
          id: output.courseWorkMaterialId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
