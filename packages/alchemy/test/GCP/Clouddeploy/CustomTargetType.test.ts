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

const waitUntilGone = (name: string) =>
  clouddeploy.getProjectsLocationsCustomTargetTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCustomTargetTypes on a missing type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        clouddeploy.getProjectsLocationsCustomTargetTypes({
          name: `projects/${project}/locations/us-central1/customTargetTypes/alchemy-missing-type`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* clouddeploy
        .listProjectsLocationsCustomTargetTypes({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ customTargetTypes: [] as const }),
          ),
        );
      expect(Array.isArray(page.customTargetTypes ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a custom target type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Clouddeploy.CustomTargetType("Helm", {
            customActions: { deployAction: "helm-deploy" },
            description: "alchemy-test-custom-target",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/customTargetTypes/");
      expect(created.customTargetTypeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-custom-target");
      expect(created.customActions?.deployAction).toEqual("helm-deploy");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* clouddeploy.getProjectsLocationsCustomTargetTypes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy-test-custom-target");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Clouddeploy.CustomTargetType("Helm", {
            customTargetTypeId: created.customTargetTypeId,
            customActions: { deployAction: "helm-deploy" },
            description: "alchemy-prod-custom-target",
            labels: { env: "prod", role: "deploy" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-custom-target");
      expect(updated.labels).toMatchObject({ env: "prod", role: "deploy" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
