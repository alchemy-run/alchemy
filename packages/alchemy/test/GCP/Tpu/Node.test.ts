import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as tpu from "@distilled.cloud/gcp/tpu_v2";
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

// Cloud TPU provisioning takes several minutes and requires TPU quota.
// Probe tests always run with creds. Full lifecycle is skipIf-gated on
// FAST and GCP_TEST_TPU=1.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_TPU && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  tpu.getProjectsLocationsNodes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tpu.getProjectsLocationsNodes({
          name: `projects/${project}/locations/us-central1-c/nodes/alchemy-tpu-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* tpu
        .listProjectsLocationsNodes({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ nodes: [] as const }),
          ),
        );
      expect(Array.isArray(page.nodes ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a TPU node",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tpu.Node("Trainer", {
            location: "us-central1-c",
            acceleratorType: "v2-8",
            runtimeVersion: "tpu-ubuntu2204-base",
            description: "alchemy-test-tpu",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/nodes/");
      expect(created.nodeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1-c");
      expect(created.acceleratorType).toEqual("v2-8");
      expect(created.description).toEqual("alchemy-test-tpu");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* tpu.getProjectsLocationsNodes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.acceleratorType).toEqual("v2-8");
      expect(fetched.description).toEqual("alchemy-test-tpu");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tpu.Node("Trainer", {
            nodeId: created.nodeId,
            location: "us-central1-c",
            acceleratorType: "v2-8",
            runtimeVersion: "tpu-ubuntu2204-base",
            description: "alchemy-prod-tpu",
            labels: { env: "prod", role: "tpu" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-tpu");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tpu" });

      const refetched = yield* tpu.getProjectsLocationsNodes({
        name: created.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-tpu");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tpu");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
