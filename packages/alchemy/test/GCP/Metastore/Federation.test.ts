import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsFederations on a missing federation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsFederations({
          name: `projects/${project}/locations/us-central1/federations/alchemy-missing-federation`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* metastore
        .listProjectsLocationsFederations({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ federations: [] as const }),
          ),
        );
      expect(Array.isArray(page.federations ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create is rejected when the Dataproc Metastore API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Metastore.Federation("Lakehouse", {
              location: "us-central1",
              version: "3.1.2",
              backendMetastores: {
                "1": {
                  name: `projects/${project}`,
                  metastoreType: "BIGQUERY",
                },
              },
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("Dataproc Metastore API");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
