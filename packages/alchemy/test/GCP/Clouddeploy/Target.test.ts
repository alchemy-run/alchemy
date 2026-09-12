import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const runLocation = `projects/${project}/locations/us-central1`;

const waitUntilGone = (name: string) =>
  clouddeploy.getProjectsLocationsTargets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsTargets on a missing target fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        clouddeploy.getProjectsLocationsTargets({
          name: `projects/${project}/locations/us-central1/targets/alchemy-missing-target`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* clouddeploy
        .listProjectsLocationsTargets({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ targets: [] as const }),
          ),
        );
      expect(Array.isArray(page.targets ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a Cloud Run target",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Clouddeploy.Target("Prod", {
            run: { location: runLocation },
            description: "alchemy-test-target",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/targets/");
      expect(created.targetId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-target");
      expect(created.run?.location).toEqual(runLocation);
      expect(created.requireApproval).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* clouddeploy.getProjectsLocationsTargets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy-test-target");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.run?.location).toEqual(runLocation);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Clouddeploy.Target("Prod", {
            targetId: created.targetId,
            run: { location: runLocation },
            requireApproval: true,
            description: "alchemy-prod-target",
            labels: { env: "prod", role: "run" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-target");
      expect(updated.requireApproval).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "run" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
