import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as documentai from "@distilled.cloud/gcp/documentai_v1";
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
const location = "us";
const parent = `projects/${project}/locations/${location}`;

const invoiceSchema: GCP.Documentai.DocumentSchemaSpec = {
  displayName: "invoice",
  description: "invoice fields",
  entityTypes: [
    {
      name: "invoice",
      baseTypes: ["document"],
      properties: [
        {
          name: "invoice_id",
          valueType: "string",
          occurrenceType: "OPTIONAL_ONCE",
        },
      ],
    },
  ],
};

const waitUntilGone = (name: string) =>
  documentai.getProjectsLocationsSchemasSchemaVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSchemasSchemaVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        documentai.getProjectsLocationsSchemasSchemaVersions({
          name: `${parent}/schemas/missing/schemaVersions/alchemy-missing-version`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a schema version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* documentai
        .listProjectsLocationsSchemas({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.Documentai.Schema("Invoice", {
            location,
            displayName: "invoice-parent",
            labels: { env: "test" },
          });
          const version = yield* GCP.Documentai.SchemasSchemaVersion("V1", {
            schema: schema.name,
            location,
            displayName: "v1",
            documentSchema: invoiceSchema,
            labels: { env: "test" },
          });
          return { schema, version };
        }),
      );

      expect(created.version.schemaVersionId).toEqual(expect.any(String));
      expect(created.version.name).toContain("/schemaVersions/");
      expect(created.version.schema).toEqual(created.schema.name);
      expect(created.version.displayName).toEqual("v1");
      expect(created.version.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* documentai.getProjectsLocationsSchemasSchemaVersions({
          name: created.version.name,
        });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.displayName).toEqual("v1");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.Documentai.Schema("Invoice", {
            schemaId: created.schema.schemaId,
            location,
            displayName: "invoice-parent",
            labels: { env: "test" },
          });
          const version = yield* GCP.Documentai.SchemasSchemaVersion("V1", {
            schema: schema.name,
            schemaVersionId: created.version.schemaVersionId,
            location,
            displayName: "v1-prod",
            documentSchema: invoiceSchema,
            labels: { env: "prod", role: "version" },
          });
          return { schema, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.displayName).toEqual("v1-prod");
      expect(updated.version.labels).toMatchObject({
        env: "prod",
        role: "version",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
