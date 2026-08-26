import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const studentId = process.env.GCP_TEST_CLASSROOM_STUDENT;
const guardianEmail = process.env.GCP_TEST_CLASSROOM_GUARDIAN;
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_CLASSROOM &&
  !!studentId &&
  !!guardianEmail;

const waitUntilGone = (student: string, invitationId: string) =>
  classroom
    .getUserProfilesGuardianInvitations({
      studentId: student,
      invitationId,
    })
    .pipe(
      Effect.map((invitation) =>
        invitation.state === "COMPLETE"
          ? ("gone" as const)
          : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getUserProfilesGuardianInvitations on a missing invitation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getUserProfilesGuardianInvitations({
          studentId: "me",
          invitationId: "missing-guardian-invitation",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and withdraw a guardian invitation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Classroom.UserProfilesGuardianInvitation("Ada", {
            studentId: studentId!,
            invitedEmailAddress: guardianEmail!,
          });
        }),
      );

      expect(created.invitationId.length).toBeGreaterThan(0);
      expect(created.studentId).toEqual(studentId);
      expect(created.invitedEmailAddress).toEqual(guardianEmail);
      expect(created.state).toEqual("PENDING");

      const fetched = yield* classroom.getUserProfilesGuardianInvitations({
        studentId: created.studentId,
        invitationId: created.invitationId,
      });
      expect(fetched.invitationId).toEqual(created.invitationId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.studentId,
        created.invitationId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
