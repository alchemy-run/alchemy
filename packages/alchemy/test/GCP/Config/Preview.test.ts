import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/gcp/config_v1";
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

const serviceAccount = `projects/${project}/serviceAccounts/alchemy-testing@${project}.iam.gserviceaccount.com`;

// Infra Manager (config.googleapis.com) is entitlement-gated. Live create
// returns Forbidden: "Infrastructure Manager API has not been used in
// project … before or it is disabled." Preview also invokes Cloud Build.
// Set GCP_TEST_CONFIG=1 on an entitled project to run the full lifecycle.
const entitled = process.env.GCP_TEST_CONFIG === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  config.getProjectsLocationsPreviews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsPreviews on a missing preview fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        config.getProjectsLocationsPreviews({
          name: `projects/${project}/locations/us-central1/previews/alchemy-missing-preview`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* config
        .listProjectsLocationsPreviews({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ previews: [] as const }),
          ),
        );
      expect(Array.isArray(page.previews ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createProjectsLocationsPreviews is rejected with Forbidden when Infra Manager is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        config.createProjectsLocationsPreviews({
          parent: `projects/${project}/locations/us-central1`,
          previewId: "alchemy-config-probe-preview",
          body: { serviceAccount },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("config.googleapis.com");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !entitled)(
  "create preview without a blueprint is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Config.Preview("Plan", {
              serviceAccount,
            });
          }),
        ),
      );
      expect(["BadRequest", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a preview",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Config.Preview("Plan", {
            serviceAccount,
            terraformBlueprint: {
              gitSource: {
                repo: "https://github.com/terraform-google-modules/terraform-docs-samples.git",
                directory: "storage/quickstart",
              },
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/previews/");
      expect(created.previewId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.serviceAccount).toEqual(serviceAccount);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* config.getProjectsLocationsPreviews({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
