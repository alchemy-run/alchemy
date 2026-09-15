import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_MANAGEDKAFKA;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const AVRO = JSON.stringify({
  type: "record",
  name: "Shipment",
  namespace: "alchemy",
  fields: [{ name: "id", type: "string" }],
});

const waitUntilGone = (name: string) =>
  kafka
    .getProjectsLocationsSchemaRegistriesContextsSubjectsVersions({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSchemaRegistriesContextsSubjectsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsSchemaRegistriesContextsSubjectsVersions({
          name: `projects/${project}/locations/us-central1/schemaRegistries/alchemy_missing/contexts/dev/subjects/missing/versions/1`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a context-scoped schema subject version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const registry = yield* GCP.Managedkafka.SchemaRegistry("Schemas", {
            location: "us-central1",
          });
          const version =
            yield* GCP.Managedkafka.SchemaRegistriesContextsSubjectsVersion(
              "ShipSchema",
              {
                schemaRegistry: registry.name,
                context: "dev",
                subject: "shipments",
                schemaType: "AVRO",
                schema: AVRO,
              },
            );
          return { registry, version };
        }),
      );

      expect(created.version.name).toContain("/contexts/");
      expect(created.version.context).toEqual("dev");
      expect(created.version.subject).toEqual("shipments");
      expect(created.version.version).toBeGreaterThan(0);

      const fetched =
        yield* kafka.getProjectsLocationsSchemaRegistriesContextsSubjectsVersions(
          { name: created.version.name },
        );
      expect(fetched.subject).toEqual("shipments");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
