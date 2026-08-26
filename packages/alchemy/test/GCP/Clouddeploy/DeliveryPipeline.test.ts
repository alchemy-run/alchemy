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
  clouddeploy.getProjectsLocationsDeliveryPipelines({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDeliveryPipelines on a missing pipeline fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        clouddeploy.getProjectsLocationsDeliveryPipelines({
          name: `projects/${project}/locations/us-central1/deliveryPipelines/alchemy-missing-pipeline`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* clouddeploy
        .listProjectsLocationsDeliveryPipelines({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ deliveryPipelines: [] as const }),
          ),
        );
      expect(Array.isArray(page.deliveryPipelines ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a delivery pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* GCP.Clouddeploy.Target("Staging", {
            run: {
              location: `projects/${project}/locations/us-central1`,
            },
            labels: { env: "test" },
          });
          const pipeline = yield* GCP.Clouddeploy.DeliveryPipeline("App", {
            serialPipeline: { stages: [{ targetId: target.targetId }] },
            description: "alchemy-test-pipeline",
            labels: { env: "test" },
          });
          return { target, pipeline };
        }),
      );

      expect(created.pipeline.name).toContain("/deliveryPipelines/");
      expect(created.pipeline.deliveryPipelineId).toEqual(expect.any(String));
      expect(created.pipeline.location).toEqual("us-central1");
      expect(created.pipeline.description).toEqual("alchemy-test-pipeline");
      expect(created.pipeline.serialPipeline?.stages?.[0]?.targetId).toEqual(
        created.target.targetId,
      );
      expect(created.pipeline.labels).toMatchObject({ env: "test" });
      expect(created.pipeline.suspended).toEqual(false);

      const fetched = yield* clouddeploy.getProjectsLocationsDeliveryPipelines({
        name: created.pipeline.name,
      });
      expect(fetched.name).toEqual(created.pipeline.name);
      expect(fetched.description).toEqual("alchemy-test-pipeline");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* GCP.Clouddeploy.Target("Staging", {
            targetId: created.target.targetId,
            run: {
              location: `projects/${project}/locations/us-central1`,
            },
            labels: { env: "test" },
          });
          const pipeline = yield* GCP.Clouddeploy.DeliveryPipeline("App", {
            deliveryPipelineId: created.pipeline.deliveryPipelineId,
            serialPipeline: { stages: [{ targetId: target.targetId }] },
            description: "alchemy-prod-pipeline",
            labels: { env: "prod", role: "deploy" },
          });
          return pipeline;
        }),
      );

      expect(updated.name).toEqual(created.pipeline.name);
      expect(updated.description).toEqual("alchemy-prod-pipeline");
      expect(updated.labels).toMatchObject({ env: "prod", role: "deploy" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.pipeline.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
