import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaseappdistribution from "@distilled.cloud/gcp/firebaseappdistribution_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
const parent = `projects/${project}`;
const entitlementTags = ["Forbidden", "NotFound", "BadRequest"] as const;
const APP_DISTRIBUTION_DISABLED =
  "Firebase App Distribution API has not been used";

const waitUntilGone = (name: string) =>
  firebaseappdistribution.getProjectsGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeAccess = () =>
  firebaseappdistribution
    .listProjectsGroups({
      parent,
      pageSize: 1,
    })
    .pipe(
      Effect.as("ok" as const),
      Effect.catchTag(["Forbidden", "NotFound"], (error) =>
        Effect.succeed(error),
      ),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaseappdistribution.getProjectsGroups({
          name: `${parent}/groups/alchemy-missing`,
        }),
      );
      expect([...entitlementTags]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a tester group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect([...entitlementTags]).toContain(access._tag);
        if (access._tag === "Forbidden") {
          expect(access.message).toContain(APP_DISTRIBUTION_DISABLED);
        }
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebaseappdistribution.Group("Qa", {
            displayName: "qa",
          });
        }),
      );

      expect(created.name).toContain("/groups/");
      expect(created.groupId).toEqual(expect.any(String));
      expect(created.groupId.length).toBeGreaterThanOrEqual(4);
      expect(created.project).toEqual(expect.any(String));
      expect(created.displayName).toEqual("qa");

      const fetched = yield* firebaseappdistribution.getProjectsGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("qa");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebaseappdistribution.Group("Qa", {
            groupId: created.groupId,
            displayName: "qa-prod",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.groupId).toEqual(created.groupId);
      expect(updated.displayName).toEqual("qa-prod");

      const refetched = yield* firebaseappdistribution.getProjectsGroups({
        name: created.name,
      });
      expect(refetched.displayName).toContain("qa-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
