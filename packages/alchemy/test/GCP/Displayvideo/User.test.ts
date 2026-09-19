import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, partnerId, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (userId: string) =>
  dv.getUsers({ userId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getUsers on a missing user fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(dv.getUsers({ userId: "1" }));
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Displayvideo.User("Analyst", {
            email: "alchemy.dv360.user@example.com",
            displayName: "analyst",
            assignedUserRoles: [{ partnerId, userRole: "READ_ONLY" }],
          });
        }),
      );

      expect(created.userId).toEqual(expect.any(String));
      expect(created.email).toEqual("alchemy.dv360.user@example.com");
      expect(created.displayName).toEqual("analyst");

      const fetched = yield* dv.getUsers({ userId: created.userId });
      expect(fetched.userId).toEqual(created.userId);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Displayvideo.User("Analyst", {
            userId: created.userId,
            email: "alchemy.dv360.user@example.com",
            displayName: "analyst-v2",
            assignedUserRoles: [{ partnerId, userRole: "READ_ONLY" }],
          });
        }),
      );

      expect(updated.userId).toEqual(created.userId);
      expect(updated.displayName).toEqual("analyst-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.userId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
