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

export type InvitationRole = "STUDENT" | "TEACHER" | "OWNER";

export type InvitationProps = {
  /**
   * Identifier of the course to invite the user to. Immutable — changing
   * it replaces the invitation.
   */
  courseId: string;
  /**
   * User to invite. Numeric user id, email address, or `"me"`. Immutable
   * — changing it replaces the invitation.
   */
  userId: string;
  /**
   * Role to invite the user as. Must not be `COURSE_ROLE_UNSPECIFIED`.
   * Immutable — Classroom has no update API, so changing role replaces
   * the invitation (delete-first; only one invitation per user and
   * course may exist).
   */
  role: InvitationRole | (string & {});
  /**
   * Classroom-assigned invitation id. Server-assigned on create.
   * Immutable — changing it replaces the invitation.
   */
  invitationId?: string;
};

export type Invitation = Resource<
  "GCP.Classroom.Invitation",
  InvitationProps,
  {
    /** Classroom-assigned invitation id. */
    invitationId: string;
    /** Course the user is invited to. */
    courseId: string;
    /** Canonical user id of the invitee. */
    userId: string;
    /** Invited role. */
    role: string | undefined;
    /** Project id used when the invitation was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A Google Classroom invitation for a user to join a course.
 *
 * Invitations have no labels or description. Identity is the
 * server-assigned id; `(courseId, userId)` is unique. Classroom has no
 * patch API — delete and recreate to change role. `list` / nuke
 * enumerates invitations on alchemy-owned courses.
 *
 * ### Creating an Invitation
 * **Example:** Invite a student
 * ```typescript
 * const invitation = yield* GCP.Classroom.Invitation("Ada", {
 *   courseId: course.id,
 *   userId: "ada@example.edu",
 *   role: "STUDENT",
 * });
 * ```
 *
 * **Example:** Invite a teacher
 * ```typescript
 * const invitation = yield* GCP.Classroom.Invitation("AdaTeacher", {
 *   courseId: course.id,
 *   userId: "ada@example.edu",
 *   role: "TEACHER",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const Invitation = Resource<Invitation>("GCP.Classroom.Invitation");

export class InvitationNotResolved extends Data.TaggedError(
  "GCP.Classroom.InvitationNotResolved",
)<{
  courseId: string;
  userId: string;
}> {}

const toAttrs = (invitation: classroom.Invitation, project: string) => ({
  invitationId: invitation.id ?? "",
  courseId: invitation.courseId ?? "",
  userId: invitation.userId ?? "",
  role: invitation.role,
  project,
});

const sameInvitee = (invitation: classroom.Invitation, userId: string) =>
  sameText(invitation.userId, userId);

const getById = (invitationId: string) =>
  invitationId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getInvitations({ id: invitationId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listBy = (query: { courseId?: string; userId?: string }) =>
  classroom.listInvitations.pages({ ...query, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.invitations ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findExisting = (courseId: string, userId: string) =>
  listBy({ courseId, userId }).pipe(
    Effect.map((invitations) =>
      invitations.find(
        (invitation) =>
          sameText(invitation.courseId, courseId) &&
          sameInvitee(invitation, userId),
      ),
    ),
  );

const listAtCourse = (courseId: string, project: string) =>
  listBy({ courseId }).pipe(
    Effect.map((invitations) =>
      invitations.map((invitation) => toAttrs(invitation, project)),
    ),
  );

export const InvitationProvider = () =>
  Provider.succeed(Invitation, {
    stables: ["invitationId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCourse = olds?.courseId ?? output?.courseId;
      if (previousCourse !== undefined && news.courseId !== previousCourse) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousUser = olds?.userId ?? output?.userId;
      if (previousUser !== undefined && news.userId !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousRole = olds?.role ?? output?.role;
      if (previousRole !== undefined && news.role !== previousRole) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.invitationId ?? output?.invitationId;
      if (
        previousId !== undefined &&
        news.invitationId !== undefined &&
        news.invitationId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const invitationId = olds?.invitationId ?? output?.invitationId ?? "";
      let existing = yield* getById(invitationId);
      if (existing === undefined) {
        const courseId = olds?.courseId ?? output?.courseId;
        const userId = olds?.userId ?? output?.userId;
        if (courseId !== undefined && userId !== undefined) {
          existing = yield* findExisting(courseId, userId);
        }
      }
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
            course.id
              ? listAtCourse(course.id, env.project)
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const courseId = news.courseId;
      const userId = news.userId;
      const role = news.role;

      let current =
        (yield* getById(news.invitationId ?? output?.invitationId ?? "")) ??
        (yield* findExisting(courseId, userId));

      if (
        current !== undefined &&
        (!sameText(current.courseId, courseId) ||
          !sameInvitee(current, userId) ||
          !sameText(current.role, role))
      ) {
        if (current.id) {
          yield* classroom
            .deleteInvitations({ id: current.id })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* classroom
          .createInvitations({
            body: { courseId, userId, role },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findExisting(courseId, userId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new InvitationNotResolved({ courseId, userId });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.invitationId.length === 0) return;
      yield* classroom
        .deleteInvitations({ id: output.invitationId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
