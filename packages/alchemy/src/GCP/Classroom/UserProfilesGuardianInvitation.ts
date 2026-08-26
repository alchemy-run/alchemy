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
import { sameText } from "./internal.ts";

export type GuardianInvitationState = "PENDING" | "COMPLETE";

export type UserProfilesGuardianInvitationProps = {
  /**
   * Student whose guardian is invited. Numeric user id, email address,
   * `"me"`, or `"-"` (list only). Immutable — changing it replaces the
   * invitation.
   */
  studentId: string;
  /**
   * Guardian email address. Immutable — changing it replaces the
   * invitation. Create only accepts this field plus `studentId`.
   */
  invitedEmailAddress: string;
  /**
   * Classroom-assigned invitation id. Server-assigned on create.
   * Immutable — changing it replaces the invitation.
   */
  invitationId?: string;
};

export type UserProfilesGuardianInvitation = Resource<
  "GCP.Classroom.UserProfilesGuardianInvitation",
  UserProfilesGuardianInvitationProps,
  {
    /** Classroom-assigned invitation id. */
    invitationId: string;
    /** Student id. */
    studentId: string;
    /** Invited guardian email. */
    invitedEmailAddress: string | undefined;
    /** Invitation state (`PENDING`, `COMPLETE`). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
    /** Project id used when the invitation was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A Google Classroom guardian invitation.
 *
 * Invitations have no labels. Identity is `(studentId,
 * invitedEmailAddress)`. There is no delete API — Alchemy withdraws a
 * pending invitation by patching `state` to `COMPLETE`. `list` / nuke
 * enumerates invitations for `studentId="-"` (every student the caller
 * can see) and keeps only engine-owned rows from prior state.
 *
 * ### Creating a Guardian Invitation
 * **Example:** Invite a guardian
 * ```typescript
 * const invitation = yield* GCP.Classroom.UserProfilesGuardianInvitation("Ada", {
 *   studentId: "ada@example.edu",
 *   invitedEmailAddress: "parent@example.edu",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Classroom
 */
export const UserProfilesGuardianInvitation =
  Resource<UserProfilesGuardianInvitation>(
    "GCP.Classroom.UserProfilesGuardianInvitation",
  );

export class UserProfilesGuardianInvitationNotResolved extends Data.TaggedError(
  "GCP.Classroom.UserProfilesGuardianInvitationNotResolved",
)<{
  studentId: string;
  invitedEmailAddress: string;
}> {}

const toAttrs = (
  invitation: classroom.GuardianInvitation,
  project: string,
  studentId: string,
) => ({
  invitationId: invitation.invitationId ?? "",
  studentId: invitation.studentId ?? studentId,
  invitedEmailAddress: invitation.invitedEmailAddress,
  state: invitation.state,
  creationTime: invitation.creationTime,
  project,
});

const getById = (studentId: string, invitationId: string) =>
  studentId.length === 0 || invitationId.length === 0
    ? Effect.succeed(undefined)
    : classroom
        .getUserProfilesGuardianInvitations({ studentId, invitationId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listBy = (studentId: string, invitedEmailAddress?: string) =>
  studentId.length === 0
    ? Effect.succeed([] as classroom.GuardianInvitation[])
    : classroom.listUserProfilesGuardianInvitations
        .pages({
          studentId,
          invitedEmailAddress,
          states: ["PENDING", "COMPLETE"],
          pageSize: 100,
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.guardianInvitations ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed([] as classroom.GuardianInvitation[]),
          ),
        );

const findExisting = (studentId: string, invitedEmailAddress: string) =>
  listBy(studentId, invitedEmailAddress).pipe(
    Effect.map((invitations) =>
      invitations.find(
        (invitation) =>
          sameText(invitation.invitedEmailAddress, invitedEmailAddress) &&
          invitation.state !== "COMPLETE",
      ),
    ),
  );

const withdraw = (studentId: string, invitationId: string) =>
  invitationId.length === 0
    ? Effect.void
    : classroom
        .patchUserProfilesGuardianInvitations({
          studentId,
          invitationId,
          updateMask: "state",
          body: { state: "COMPLETE" },
        })
        .pipe(
          Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void),
          Effect.asVoid,
        );

export const UserProfilesGuardianInvitationProvider = () =>
  Provider.succeed(UserProfilesGuardianInvitation, {
    stables: ["invitationId", "studentId", "project", "creationTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousStudent = olds?.studentId ?? output?.studentId;
      const previousEmail =
        olds?.invitedEmailAddress ?? output?.invitedEmailAddress;
      const previousId = olds?.invitationId ?? output?.invitationId;
      if (
        (previousStudent !== undefined && news.studentId !== previousStudent) ||
        (previousEmail !== undefined &&
          news.invitedEmailAddress !== previousEmail) ||
        (previousId !== undefined &&
          news.invitationId !== undefined &&
          news.invitationId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const studentId = olds?.studentId ?? output?.studentId ?? "";
      const invitationId = olds?.invitationId ?? output?.invitationId ?? "";
      let existing = yield* getById(studentId, invitationId);
      if (existing === undefined) {
        const email = olds?.invitedEmailAddress ?? output?.invitedEmailAddress;
        if (studentId && email) {
          existing = yield* findExisting(studentId, email);
        }
      }
      if (existing === undefined || existing.state === "COMPLETE") {
        return undefined;
      }
      const attrs = toAttrs(existing, env.project, studentId);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const invitations = yield* listBy("-");
        return invitations
          .filter((invitation) => invitation.state !== "COMPLETE")
          .map((invitation) =>
            toAttrs(invitation, env.project, invitation.studentId ?? ""),
          );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const studentId = news.studentId;
      const invitedEmailAddress = news.invitedEmailAddress;

      let current =
        (yield* getById(
          studentId,
          news.invitationId ?? output?.invitationId ?? "",
        )) ?? (yield* findExisting(studentId, invitedEmailAddress));

      if (
        current !== undefined &&
        (!sameText(current.invitedEmailAddress, invitedEmailAddress) ||
          current.state === "COMPLETE")
      ) {
        if (current.invitationId && current.state !== "COMPLETE") {
          yield* withdraw(studentId, current.invitationId);
        }
        current =
          current.state === "COMPLETE" &&
          sameText(current.invitedEmailAddress, invitedEmailAddress)
            ? current
            : undefined;
      }

      if (current === undefined || current.state === "COMPLETE") {
        current = undefined;
        const created = yield* classroom
          .createUserProfilesGuardianInvitations({
            studentId,
            body: { studentId, invitedEmailAddress },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findExisting(studentId, invitedEmailAddress),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UserProfilesGuardianInvitationNotResolved({
          studentId,
          invitedEmailAddress,
        });
      }

      return toAttrs(current, env.project, studentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.invitationId || !output.studentId) return;
      yield* withdraw(output.studentId, output.invitationId);
    }),
  });
