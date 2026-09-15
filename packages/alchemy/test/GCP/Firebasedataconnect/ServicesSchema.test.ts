import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  missingSchema,
  probeTags,
  project,
  runLifecycle,
  schemaSource,
  unlinkedDatasources,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  firebasedataconnect.getProjectsLocationsServicesSchemas({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createProjectsLocationsServicesSchemas is Forbidden when Firebase Data Connect is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebasedataconnect.createProjectsLocationsServicesSchemas({
          parent: `projects/${project}/locations/${location}/services/alchemy-missing-service`,
          schemaId: "main",
          body: {
            source: schemaSource(),
            datasources: unlinkedDatasources,
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain(
        "Firebase SQL Connect API has not been used",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsServicesSchemas on a missing schema fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebasedataconnect.getProjectsLocationsServicesSchemas({
          name: missingSchema(),
        }),
      );
      expect(probeTags).toContain(error._tag);

      const page = yield* firebasedataconnect
        .listProjectsLocationsServicesSchemas({
          parent: `projects/${project}/locations/${location}/services/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ schemas: [] as const }),
          ),
        );
      expect(Array.isArray(page.schemas ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a Data Connect schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* GCP.Firebasedataconnect.Service("App", {
            displayName: "alchemy-test-dataconnect",
            labels: { env: "test" },
          });
          const schema = yield* GCP.Firebasedataconnect.ServicesSchema("Main", {
            service: service.name,
            source: schemaSource(),
            datasources: unlinkedDatasources,
            displayName: "alchemy-test-schema",
            labels: { env: "test" },
          });
          return { service, schema };
        }),
      );

      expect(created.schema.name).toContain("/schemas/main");
      expect(created.schema.schemaId).toEqual("main");
      expect(created.schema.location).toEqual(location);
      expect(created.schema.displayName).toEqual("alchemy-test-schema");
      expect(created.schema.labels).toMatchObject({ env: "test" });
      expect(created.schema.service).toEqual(created.service.name);
      expect(created.schema.reconciling).toEqual(false);

      const fetched =
        yield* firebasedataconnect.getProjectsLocationsServicesSchemas({
          name: created.schema.name,
        });
      expect(fetched.name).toEqual(created.schema.name);
      expect(fetched.displayName).toEqual("alchemy-test-schema");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.source?.files?.[0]?.path).toEqual("schema.gql");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* GCP.Firebasedataconnect.Service("App", {
            serviceId: created.service.serviceId,
            displayName: "alchemy-prod-dataconnect",
            labels: { env: "prod" },
          });
          const schema = yield* GCP.Firebasedataconnect.ServicesSchema("Main", {
            service: service.name,
            source: schemaSource("body: String"),
            datasources: unlinkedDatasources,
            displayName: "alchemy-prod-schema",
            labels: { env: "prod", role: "schema" },
          });
          return { service, schema };
        }),
      );

      expect(updated.schema.name).toEqual(created.schema.name);
      expect(updated.schema.displayName).toEqual("alchemy-prod-schema");
      expect(updated.schema.labels).toMatchObject({
        env: "prod",
        role: "schema",
      });

      const refetched =
        yield* firebasedataconnect.getProjectsLocationsServicesSchemas({
          name: created.schema.name,
        });
      expect(refetched.displayName).toEqual("alchemy-prod-schema");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.source?.files?.[0]?.content).toContain("body: String");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.schema.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
