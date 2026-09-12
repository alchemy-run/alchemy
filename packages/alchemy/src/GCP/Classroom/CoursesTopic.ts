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
  listCourses,
  MAX_TOPIC_NAME_LENGTH,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type CoursesTopicProps = {
  /**
   * Identifier of the parent course (Classroom-assigned id or alias).
   * Immutable — changing it replaces the topic.
   */
  courseId: string;
  /**
   * Classroom-assigned topic id. Server-assigned on create. Immutable —
   * changing it replaces the topic.
   */
  topicId?: string;
  /**
   * Topic name (max 100 characters including Alchemy's ownership
   * marker). Classroom topics have no labels field, so ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
};

export type CoursesTopic = Resource<
  "GCP.Classroom.CoursesTopic",
  CoursesTopicProps,
  {
    /** Classroom-assigned topic id. */
    topicId: string;
    /** Parent course id. */
    courseId: string;
    /** Project id used when the topic was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Classroom topic grouping course work in a course.
 *
 * Classroom topics have no labels field, so Alchemy stamps ownership
 * into `name` for `list` / nuke. Parent course and id are immutable.
 * Name updates in place.
 *
 * ### Creating a Topic
 * **Example:** Generated name
 * ```typescript
 * const topic = yield* GCP.Classroom.CoursesTopic("Week1", {
 *   courseId: course.id,
 * });
 * ```
 *
 * **Example:** Explicit name
 * ```typescript
 * const topic = yield* GCP.Classroom.CoursesTopic("Week1", {
 *   courseId: course.id,
 *   name: "Week 1",
 * });
 * ```
 *
 * ### Updating a Topic
 * **Example:** Rename
 * ```typescript
 * const topic = yield* GCP.Classroom.CoursesTopic("Week1", {
 *   courseId: existing.courseId,
 *   topicId: existing.topicId,
 *   name: "Week 1 — intro",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const CoursesTopic = Resource<CoursesTopic>(
  "GCP.Classroom.CoursesTopic",
);

export class CoursesTopicNotResolved extends Data.TaggedError(
  "GCP.Classroom.CoursesTopicNotResolved",
)<{
  courseId: string;
  topicId: string;
}> {}

const toAttrs = (topic: classroom.Topic, project: string) => ({
  topicId: topic.topicId ?? "",
  courseId: topic.courseId ?? "",
  project,
  name: parseOwnership(topic.name).text,
  updateTime: topic.updateTime,
});

const getById = (courseId: string, topicId: string) =>
  courseId.length === 0 || topicId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCoursesTopics({ courseId, id: topicId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (courseId: string, project: string) =>
  classroom.listCoursesTopics.pages({ courseId, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.topic ?? [])),
    Stream.filter((topic) => hasOwnershipMarker(topic.name)),
    Stream.map((topic) => toAttrs(topic, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findByName = (courseId: string, name: string) =>
  classroom.listCoursesTopics.pages({ courseId, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.topic ?? [])),
    Stream.filter((topic) => topic.name === name),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

export const CoursesTopicProvider = () =>
  Provider.succeed(CoursesTopic, {
    stables: ["topicId", "courseId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.topicId ?? output?.topicId;
      if (
        previousId !== undefined &&
        news.topicId !== undefined &&
        news.topicId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const courseId = olds?.courseId ?? output?.courseId ?? "";
      const topicId = olds?.topicId ?? output?.topicId ?? "";
      let existing = yield* getById(courseId, topicId);
      if (existing === undefined && courseId.length > 0) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByName(
          courseId,
          encodeOwnershipLine(
            ownership,
            olds?.name ?? output?.name,
            MAX_TOPIC_NAME_LENGTH,
          ),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.name))
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
            course.id ? listAt(course.id, env.project) : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const courseId = news.courseId;
      const topicId = news.topicId ?? output?.topicId ?? "";
      const ownership = yield* createInternalLabels(id);
      const name = encodeOwnershipLine(
        ownership,
        news.name ?? output?.name,
        MAX_TOPIC_NAME_LENGTH,
      );

      let current = yield* getById(courseId, topicId);
      if (current === undefined) {
        current = yield* findByName(courseId, name);
      }

      if (current === undefined) {
        const created = yield* classroom
          .createCoursesTopics({
            courseId,
            body: { name },
          })
          .pipe(Effect.catchTag("Conflict", () => findByName(courseId, name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CoursesTopicNotResolved({
          courseId,
          topicId: topicId || name,
        });
      }

      const currentId = current.topicId ?? topicId;
      if (!sameText(current.name, name)) {
        current = yield* classroom.patchCoursesTopics({
          courseId,
          id: currentId,
          updateMask: updateMaskOf("name"),
          body: { name },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.courseId.length === 0 || output.topicId.length === 0) {
        return;
      }
      yield* classroom
        .deleteCoursesTopics({
          courseId: output.courseId,
          id: output.topicId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
