import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
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
const parent = `projects/${project}/locations/global`;

const waitUntilGone = (name: string) =>
  osconfig.getProjectsLocationsGlobalPolicyOrchestrators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGlobalPolicyOrchestrators on a missing orchestrator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        osconfig.getProjectsLocationsGlobalPolicyOrchestrators({
          name: `${parent}/policyOrchestrators/alchemy-missing-orch`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("OS Config API has not been used");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a project policy orchestrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* osconfig
        .listProjectsLocationsGlobalPolicyOrchestrators({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(access).toEqual("Forbidden");
        const listed = yield* Effect.flip(
          osconfig.listProjectsLocationsGlobalPolicyOrchestrators({
            parent,
            pageSize: 1,
          }),
        );
        expect(listed._tag).toEqual("Forbidden");
        if (listed._tag === "Forbidden") {
          expect(listed.message).toContain("OS Config API has not been used");
        }
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Osconfig.ProjectsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              description: "validation only",
              labels: { env: "test" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(created.policyOrchestratorId).toEqual(expect.any(String));
      expect(created.parent).toEqual(parent);
      expect(created.name).toEqual(
        `${parent}/policyOrchestrators/${created.policyOrchestratorId}`,
      );
      expect(created.action).toEqual("UPSERT");
      expect(created.state).toEqual("STOPPED");
      expect(created.description).toEqual("validation only");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* osconfig.getProjectsLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.state).toEqual("STOPPED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Osconfig.ProjectsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              policyOrchestratorId: created.policyOrchestratorId,
              description: "updated",
              labels: { env: "prod", role: "os" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated");
      expect(updated.labels).toMatchObject({ env: "prod", role: "os" });

      const refetched =
        yield* osconfig.getProjectsLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(refetched.description).toEqual("updated");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
