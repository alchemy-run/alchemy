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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_TPU && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  tpu.getProjectsLocationsQueuedResources({ name }).pipe(
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
  "getProjectsLocationsQueuedResources on a missing resource fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tpu.getProjectsLocationsQueuedResources({
          name: `projects/${project}/locations/us-central1-c/queuedResources/alchemy-tpu-qr-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* tpu
        .listProjectsLocationsQueuedResources({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ queuedResources: [] as const }),
          ),
        );
      expect(Array.isArray(page.queuedResources ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a TPU queued resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tpu.QueuedResource("Trainer", {
            location: "us-central1-c",
            nodeSpec: [
              {
                node: {
                  acceleratorType: "v2-8",
                  runtimeVersion: "tpu-ubuntu2204-base",
                  description: "alchemy-test-qr",
                  labels: { env: "test" },
                },
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/queuedResources/");
      expect(created.queuedResourceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1-c");
      expect(created.nodeSpec.length).toBeGreaterThan(0);
      expect(created.nodeSpec[0]?.node?.acceleratorType).toEqual("v2-8");
      expect(created.nodeSpec[0]?.node?.description).toEqual("alchemy-test-qr");
      expect(created.nodeSpec[0]?.node?.labels).toMatchObject({ env: "test" });

      const fetched = yield* tpu.getProjectsLocationsQueuedResources({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.tpu?.nodeSpec?.[0]?.node?.acceleratorType).toEqual("v2-8");
      expect(fetched.tpu?.nodeSpec?.[0]?.node?.labels?.env).toEqual("test");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
