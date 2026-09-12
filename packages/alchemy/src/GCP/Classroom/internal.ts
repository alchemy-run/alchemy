import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_OWNER = "me";
export const MAX_TOPIC_NAME_LENGTH = 100;
export const MAX_ATTACHMENT_TITLE_LENGTH = 1000;
export const MAX_COURSE_NAME_LENGTH = 750;
export const MAX_ALIAS_LENGTH = 40;

export type ClassroomDate = {
  year?: number;
  month?: number;
  day?: number;
};

export type TimeOfDay = {
  hours?: number;
  minutes?: number;
  seconds?: number;
  nanos?: number;
};

export type EmbedUri = {
  uri?: string;
};

export type CopyHistory = {
  courseId?: string;
  attachmentId?: string;
  itemId?: string;
  postId?: string;
};

export type IndividualStudentsOptions = {
  studentIds?: string[];
};

export type Material = classroom.Material;

export type AddOnAttachmentBody = {
  title?: string;
  studentViewUri?: EmbedUri;
  teacherViewUri?: EmbedUri;
  studentWorkReviewUri?: EmbedUri;
  dueDate?: ClassroomDate;
  dueTime?: TimeOfDay;
  maxPoints?: number;
};

export type RubricLevel = {
  id?: string;
  title?: string;
  description?: string;
  points?: number;
};

export type RubricCriterion = {
  id?: string;
  title?: string;
  description?: string;
  levels?: RubricLevel[];
};

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameJson = jsonEqual;

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_TOPIC_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `c${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_TOPIC_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const internalLabels = (id: string) => createInternalLabels(id);

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const isAliasId = (value: string) =>
  value.startsWith("p:") || value.startsWith("d:");

export const toCourseAlias = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && isAliasId(requested)) return requested;
    if (existing !== undefined && isAliasId(existing)) return existing;
    const generated = yield* toResourceId(
      id,
      undefined,
      undefined,
      MAX_ALIAS_LENGTH,
    );
    return `p:${generated}`;
  });

export const lookupCourseId = (
  requested: string | undefined,
  existing: string | undefined,
  alias: string,
) => {
  if (
    requested !== undefined &&
    requested.length > 0 &&
    !isAliasId(requested)
  ) {
    return requested;
  }
  if (existing !== undefined && existing.length > 0 && !isAliasId(existing)) {
    return existing;
  }
  return alias;
};

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, MAX_COURSE_NAME_LENGTH);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, MAX_COURSE_NAME_LENGTH);
    }
    return yield* toResourceId(id, undefined, undefined, 40);
  });

export const desiredAddOnTitle = (
  labels: Record<string, string>,
  title: string | undefined,
) => encodeOwnershipLine(labels, title, MAX_ATTACHMENT_TITLE_LENGTH);

export const isOwnedCourse = (course: classroom.Course) =>
  hasOwnershipMarker(course.description) ||
  hasOwnershipMarker(course.name) ||
  hasOwnershipMarker(course.section);

const emptyList = <A>() => Effect.succeed([] as A[]);

export const listCourses = () =>
  classroom.listCourses.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.courses ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<classroom.Course>()),
    Effect.catchTag("Forbidden", () => emptyList<classroom.Course>()),
  );

export const listOwnedCourses = () =>
  listCourses().pipe(Effect.map((courses) => courses.filter(isOwnedCourse)));

export const courseIdsOf = (courses: readonly classroom.Course[]) =>
  courses
    .map((course) => course.id)
    .filter((id): id is string => id !== undefined && id.length > 0);

export const getCourse = (id: string) =>
  id.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getCourses({ id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const findOwnedCourse = (id: string) =>
  Effect.gen(function* () {
    const courses = yield* listCourses();
    for (const course of courses) {
      if (yield* ownedByAlchemy(id, course.description)) {
        return course;
      }
    }
    return undefined;
  });

export const archiveThenDeleteCourse = (courseId: string) =>
  Effect.gen(function* () {
    if (courseId.length === 0) return;
    const current = yield* getCourse(courseId);
    if (current === undefined) return;
    if (current.courseState !== "ARCHIVED") {
      yield* classroom
        .patchCourses({
          id: courseId,
          updateMask: "courseState",
          body: { courseState: "ARCHIVED" },
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
        );
    }
    yield* classroom
      .deleteCourses({ id: courseId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

export const individualStudentsOf = (
  options: classroom.IndividualStudentsOptions | undefined,
): IndividualStudentsOptions | undefined => {
  if (options === undefined) return undefined;
  return { studentIds: options.studentIds };
};

export const materialsOf = (
  materials: classroom.MaterialList | undefined,
): Material[] | undefined => {
  if (materials === undefined) return undefined;
  return materials.map((material) => ({
    driveFile: material.driveFile,
    youtubeVideo: material.youtubeVideo,
    form: material.form,
    link: material.link,
    gem: material.gem,
    notebook: material.notebook,
  }));
};

export const addOnAttachmentOf = (attachment: classroom.AddOnAttachment) => ({
  id: attachment.id ?? "",
  courseId: attachment.courseId ?? "",
  itemId: attachment.itemId ?? "",
  postId: attachment.postId,
  title: parseOwnership(attachment.title).text,
  studentViewUri: attachment.studentViewUri,
  teacherViewUri: attachment.teacherViewUri,
  studentWorkReviewUri: attachment.studentWorkReviewUri,
  dueDate: attachment.dueDate,
  dueTime: attachment.dueTime,
  maxPoints: attachment.maxPoints,
  copyHistory: attachment.copyHistory?.map((entry) => ({
    courseId: entry.courseId,
    attachmentId: entry.attachmentId,
    itemId: entry.itemId,
    postId: entry.postId,
  })),
});

export const criteriaOf = (
  criteria: classroom.CriterionList | undefined,
): RubricCriterion[] | undefined => {
  if (criteria === undefined) return undefined;
  return criteria.map((criterion, index) => ({
    id: criterion.id,
    title: criterion.title,
    description:
      index === 0
        ? parseOwnership(criterion.description).text
        : criterion.description,
    levels: criterion.levels?.map((level) => ({
      id: level.id,
      title: level.title,
      description: level.description,
      points: level.points,
    })),
  }));
};

export const stampCriteria = (
  labels: Record<string, string>,
  criteria: readonly RubricCriterion[] | undefined,
): classroom.Criterion[] | undefined => {
  if (criteria === undefined) return undefined;
  return criteria.map((criterion, index) => ({
    id: criterion.id,
    title: criterion.title,
    description:
      index === 0
        ? encodeOwnership(labels, criterion.description)
        : criterion.description,
    levels: criterion.levels,
  }));
};

export const rubricOwnershipText = (rubric: classroom.Rubric) =>
  rubric.criteria?.[0]?.description;

export const listAnnouncements = (courseId: string) =>
  courseId.length === 0
    ? emptyList<classroom.Announcement>()
    : classroom.listCoursesAnnouncements
        .pages({
          courseId,
          pageSize: 100,
          announcementStates: ["PUBLISHED", "DRAFT"],
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.announcements ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<classroom.Announcement>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<classroom.Announcement>(),
          ),
        );

export const listCourseWork = (courseId: string) =>
  courseId.length === 0
    ? emptyList<classroom.CourseWork>()
    : classroom.listCoursesCourseWork
        .pages({
          courseId,
          pageSize: 100,
          courseWorkStates: ["PUBLISHED", "DRAFT"],
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.courseWork ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<classroom.CourseWork>()),
          Effect.catchTag("Forbidden", () => emptyList<classroom.CourseWork>()),
        );

export const listCourseWorkMaterials = (courseId: string) =>
  courseId.length === 0
    ? emptyList<classroom.CourseWorkMaterial>()
    : classroom.listCoursesCourseWorkMaterials
        .pages({
          courseId,
          pageSize: 100,
          courseWorkMaterialStates: ["PUBLISHED", "DRAFT"],
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.courseWorkMaterial ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<classroom.CourseWorkMaterial>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<classroom.CourseWorkMaterial>(),
          ),
        );

export const listAnnouncementAddOnAttachments = (
  courseId: string,
  itemId: string,
) =>
  courseId.length === 0 || itemId.length === 0
    ? emptyList<classroom.AddOnAttachment>()
    : classroom.listCoursesAnnouncementsAddOnAttachments
        .pages({ courseId, itemId, pageSize: 20 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.addOnAttachments ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<classroom.AddOnAttachment>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<classroom.AddOnAttachment>(),
          ),
        );

export const listCourseWorkAddOnAttachments = (
  courseId: string,
  itemId: string,
) =>
  courseId.length === 0 || itemId.length === 0
    ? emptyList<classroom.AddOnAttachment>()
    : classroom.listCoursesCourseWorkAddOnAttachments
        .pages({ courseId, itemId, pageSize: 20 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.addOnAttachments ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<classroom.AddOnAttachment>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<classroom.AddOnAttachment>(),
          ),
        );

export const listCourseWorkMaterialAddOnAttachments = (
  courseId: string,
  itemId: string,
) =>
  courseId.length === 0 || itemId.length === 0
    ? emptyList<classroom.AddOnAttachment>()
    : classroom.listCoursesCourseWorkMaterialsAddOnAttachments
        .pages({ courseId, itemId, pageSize: 20 })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.addOnAttachments ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<classroom.AddOnAttachment>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<classroom.AddOnAttachment>(),
          ),
        );

export const listRubrics = (courseId: string, courseWorkId: string) =>
  courseId.length === 0 || courseWorkId.length === 0
    ? emptyList<classroom.Rubric>()
    : classroom.listCoursesCourseWorkRubrics
        .pages({ courseId, courseWorkId, pageSize: 1 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.rubrics ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<classroom.Rubric>()),
          Effect.catchTag("Forbidden", () => emptyList<classroom.Rubric>()),
        );
