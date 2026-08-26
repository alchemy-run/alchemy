import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as classroom from "@distilled.cloud/gcp/classroom_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteCourse, ensureCourse } from "./parent.ts";

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

const classroomUser = process.env.GCP_TEST_CLASSROOM_USER;
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_CLASSROOM &&
  !!classroomUser;

const waitUntilGone = (invitationId: string) =>
  classroom.getInvitations({ id: invitationId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getInvitations on a missing invitation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        classroom.getInvitations({ id: "missing-invitation" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an invitation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const course = yield* ensureCourse("alch-invite");
      const courseId = course.id ?? "";
      const userId = classroomUser!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Classroom.Invitation("Ada", {
            courseId,
            userId,
            role: "STUDENT",
          });
        }),
      );

      expect(created.courseId).toEqual(courseId);
      expect(created.invitationId.length).toBeGreaterThan(0);
      expect(created.role).toEqual("STUDENT");

      const fetched = yield* classroom.getInvitations({
        id: created.invitationId,
      });
      expect(fetched.id).toEqual(created.invitationId);
      expect(fetched.courseId).toEqual(courseId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Classroom.Invitation("Ada", {
            courseId,
            userId: created.userId,
            role: "STUDENT",
            invitationId: created.invitationId,
          });
        }),
      );

      expect(updated.invitationId).toEqual(created.invitationId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.invitationId);
      expect(gone).toEqual("gone");

      yield* deleteCourse(courseId);
    }).pipe(logLevel),
  { timeout: 90_000 },
);
