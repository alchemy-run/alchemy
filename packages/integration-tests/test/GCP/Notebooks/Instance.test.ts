import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as notebooks from "@distilled.cloud/gcp/notebooks_v2";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1-a";

const NotebooksApi = GCP.ServiceUsage.ProjectService("NotebooksApi", {
  service: "notebooks.googleapis.com",
});

const lab = (props: { labels: Record<string, string>; metadata?: Record<string, string> }) =>
  Effect.gen(function* () {
    yield* NotebooksApi;
    return yield* GCP.Notebooks.Instance("Lab", {
      location,
      machineType: "e2-standard-2",
      ...props,
    });
  });

const waitUntilGone = (name: string) =>
  notebooks.getProjectsLocationsInstances({ name }).pipe(
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
      yield* stack.deploy(NotebooksApi);

      const error = yield* Effect.flip(
        notebooks.getProjectsLocationsInstances({
          name: `projects/${project}/locations/${location}/instances/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:notebooks", "live"], timeout: 90_000 },
);

// A Workbench VM takes several minutes to provision, so `--fast` skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a Workbench instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(lab({ labels: { env: "test" } }));
      expect(created.name).toContain(`/locations/${location}/instances/`);
      expect(created.machineType).toEqual("e2-standard-2");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* notebooks.getProjectsLocationsInstances({ name: created.name });
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const unchanged = yield* stack.plan(lab({ labels: { env: "test" } }));
      expect(unchanged.resources.Lab?.action).toEqual("noop");

      // Labels and metadata update in place.
      const updated = yield* stack.deploy(
        lab({ labels: { env: "prod" }, metadata: { "alchemy-note": "updated" } }),
      );
      expect(updated.name).toEqual(created.name);
      const refetched = yield* notebooks.getProjectsLocationsInstances({ name: created.name });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.gceSetup?.metadata?.["alchemy-note"]).toEqual("updated");

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:notebooks", "live"], timeout: 1_800_000 },
);
