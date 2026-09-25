import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!(process.env.GCP_TEST_AIPLATFORM || process.env.GCP_TEST_VERTEX);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parent = `projects/${project}/locations/us-central1`;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsEvaluationRuns({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsEvaluationRuns on a missing run fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsEvaluationRuns({
          name: `${parent}/evaluationRuns/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (String(error._tag) === "BadRequest") {
        yield* stack.destroy();
        return;
      }

      const page = yield* aiplatform
        .listProjectsLocationsEvaluationRuns({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ evaluationRuns: [] as const }),
          ),
        );
      expect(Array.isArray(page.evaluationRuns ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a vertex evaluation run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const item = yield* GCP.AIPlatform.EvaluationItem("Prompt", {
            location: "us-central1",
            displayName: "alchemy-eval-run-item",
            evaluationItemType: "REQUEST",
            evaluationRequest: { prompt: { text: "What is 2+2?" } },
            labels: { env: "test" },
          });
          const set = yield* GCP.AIPlatform.EvaluationSet("Prompts", {
            location: "us-central1",
            displayName: "alchemy-eval-run-set",
            evaluationItems: [item.name],
          });
          return yield* GCP.AIPlatform.EvaluationRun("Quality", {
            location: "us-central1",
            displayName: "alchemy-eval-run",
            dataSource: { evaluationSet: set.name },
            evaluationConfig: {
              metrics: [
                {
                  metric: "instruction_following_v1",
                  predefinedMetricSpec: {
                    metricSpecName: "instruction_following_v1",
                  },
                },
              ],
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/evaluationRuns/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsEvaluationRuns({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
