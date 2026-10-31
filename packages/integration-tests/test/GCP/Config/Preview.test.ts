import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as config from "@distilled.cloud/gcp/config_v1";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// A preview runs Terraform through Cloud Build as a service account holding
// the Infra Manager agent role; the lifecycle creates one. Terraform takes
// minutes, so `--fast` skips it.
const runLifecycle = !process.env.FAST;

/** A service account Infra Manager runs Terraform as. */
const Runner = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const account = yield* GCP.IAM.ServiceAccount("PreviewRunner", {
    displayName: "infra manager preview runner",
  });
  yield* GCP.IAM.Member("PreviewRunnerAgent", {
    kind: "project",
    name: project,
    role: "roles/config.agent",
    member: Output.interpolate`serviceAccount:${account.email}`,
  });
  return account;
});

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

test.provider(
  "getProjectsLocationsPreviews on a missing preview fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        config.getProjectsLocationsPreviews({
          name: `projects/${project}/locations/us-central1/previews/alchemy-missing-preview`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:config", "live"], timeout: 90_000 },
);

test.provider(
  "create preview without a blueprint is rejected with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const serviceAccount = `projects/${project}/serviceAccounts/alchemy-testing@${project}.iam.gserviceaccount.com`;
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
      // "invalid preview: missing required terraform blueprint specification"
      expect(error._tag).toEqual("BadRequest");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:config", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a preview",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const runner = yield* Runner;
          return yield* GCP.Config.Preview("Plan", {
            serviceAccount: runner.name,
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
      expect(created.serviceAccount).toContain("/serviceAccounts/");
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
  { tags: ["provider:gcp", "provider:gcp:config", "live"], timeout: 900_000 },
);
