import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as datafusion from "@distilled.cloud/gcp/datafusion_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1";

const DataFusionApi = GCP.ServiceUsage.ProjectService("DataFusionApi", {
  service: "datafusion.googleapis.com",
});

const fusion = (props: { enableStackdriverLogging: boolean; labels: Record<string, string> }) =>
  Effect.gen(function* () {
    yield* DataFusionApi;
    return yield* GCP.DataFusion.Instance("Pipelines", {
      location,
      type: "DEVELOPER",
      ...props,
    });
  });

const waitUntilGone = (name: string) =>
  datafusion.getProjectsLocationsInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

test.provider(
  "getProjectsLocationsInstances on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(DataFusionApi);

      const error = yield* Effect.flip(
        datafusion.getProjectsLocationsInstances({
          name: `projects/${project}/locations/${location}/instances/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:datafusion", "live"], timeout: 90_000 },
);

// A Data Fusion instance takes 15–25 minutes to provision, so `--fast` skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a Data Fusion instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        fusion({ enableStackdriverLogging: false, labels: { env: "test" } }),
      );
      expect(created.name).toContain(`/locations/${location}/instances/`);
      expect(created.state).toEqual("ACTIVE");
      expect(created.serviceEndpoint).toEqual(expect.any(String));

      const unchanged = yield* stack.plan(
        fusion({ enableStackdriverLogging: false, labels: { env: "test" } }),
      );
      expect(unchanged.resources.Pipelines?.action).toEqual("noop");

      // Logging updates in place.
      const updated = yield* stack.deploy(
        fusion({ enableStackdriverLogging: true, labels: { env: "test" } }),
      );
      expect(updated.name).toEqual(created.name);
      const fetched = yield* datafusion.getProjectsLocationsInstances({ name: created.name });
      expect(fetched.enableStackdriverLogging).toEqual(true);

      // Labels are fixed at create: new labels are a new instance.
      const relabeled = yield* stack.plan(
        fusion({ enableStackdriverLogging: true, labels: { env: "prod" } }),
      );
      expect(relabeled.resources.Pipelines?.action).toEqual("replace");

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:datafusion", "live"], timeout: 3_600_000 },
);
