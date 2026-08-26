import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
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
const parent = `projects/${project}/locations/us-central1`;

// Workload Manager API is entitlement-gated on the default testing project
// (`Forbidden`: "Workload Manager API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_WORKLOADMANAGER=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_WORKLOADMANAGER === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  workloadmanager.getProjectsLocationsEvaluations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const firstRuleName = Effect.gen(function* () {
  const page = yield* workloadmanager
    .listProjectsLocationsRules({
      parent,
      evaluationType: "SAP",
      pageSize: 20,
    })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed({ rules: [] as const }),
      ),
    );
  const named = (page.rules ?? []).find(
    (rule) => typeof rule.name === "string" && rule.name.length > 0,
  );
  return named?.name ?? "sap-hana";
});

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsEvaluations on a missing evaluation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.getProjectsLocationsEvaluations({
          name: `${parent}/evaluations/alchemy-missing-evaluation`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "Workload Manager API has not been used",
        );
      }

      const page = yield* workloadmanager
        .listProjectsLocationsEvaluations({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ evaluations: [] as const }),
          ),
        );
      expect(Array.isArray(page.evaluations ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createProjectsLocationsEvaluations is rejected with Forbidden when Workload Manager is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.createProjectsLocationsEvaluations({
          parent,
          evaluationId: "alchemy-evaluation-probe",
          body: {
            evaluationType: "SAP",
            ruleNames: ["sap-hana"],
            resourceFilter: { scopes: [`projects/${project}`] },
            description: "alchemy-probe",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an evaluation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ruleName = yield* firstRuleName;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Workloadmanager.Evaluation("SapBest", {
            evaluationType: "SAP",
            ruleNames: [ruleName],
            resourceFilter: { scopes: [`projects/${project}`] },
            description: "alchemy-test-evaluation",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/evaluations/");
      expect(created.evaluationId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("alchemy-test-evaluation");
      expect(created.ruleNames.length).toBeGreaterThan(0);

      const fetched = yield* workloadmanager.getProjectsLocationsEvaluations({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Workloadmanager.Evaluation("SapBest", {
            evaluationId: created.evaluationId,
            evaluationType: "SAP",
            ruleNames: [ruleName],
            resourceFilter: { scopes: [`projects/${project}`] },
            description: "alchemy-test-evaluation-v2",
            labels: { env: "prod", role: "eval" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.evaluationId).toEqual(created.evaluationId);
      expect(updated.description).toEqual("alchemy-test-evaluation-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "eval" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
