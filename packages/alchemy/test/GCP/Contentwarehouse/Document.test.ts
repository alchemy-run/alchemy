import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us";
const parent = `projects/${project}/locations/${location}`;

const waitUntilGone = (name: string) =>
  cw.getProjectsLocationsDocuments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDocuments on a missing document fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cw.getProjectsLocationsDocuments({
          name: `${parent}/documents/alchemy-missing-document`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a document",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* cw
        .listProjectsLocationsDocumentSchemas({
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
          const schema = yield* GCP.Contentwarehouse.DocumentSchema("Note", {
            location,
            displayName: "note",
            propertyDefinitions: [
              {
                name: "title",
                isSearchable: true,
                textTypeOptions: {},
              },
            ],
          });
          const document = yield* GCP.Contentwarehouse.Document("Welcome", {
            location,
            documentSchemaName: schema.name,
            displayName: "welcome",
            title: "welcome",
            plainText: "hello warehouse",
          });
          return { schema, document };
        }),
      );

      expect(created.document.name).toContain("/documents/");
      expect(created.document.documentId).toEqual(expect.any(String));
      expect(created.document.displayName).toEqual("welcome");
      expect(created.document.plainText).toEqual("hello warehouse");
      expect(created.document.documentSchemaName).toEqual(created.schema.name);

      const fetched = yield* cw.getProjectsLocationsDocuments({
        name: created.document.name,
      });
      expect(fetched.name).toEqual(created.document.name);
      expect(fetched.displayName).toContain("alchemy-");
      expect(fetched.plainText).toEqual("hello warehouse");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.Contentwarehouse.DocumentSchema("Note", {
            documentSchemaId: created.schema.documentSchemaId,
            location,
            displayName: "note",
            propertyDefinitions: [
              {
                name: "title",
                isSearchable: true,
                textTypeOptions: {},
              },
            ],
          });
          const document = yield* GCP.Contentwarehouse.Document("Welcome", {
            documentId: created.document.documentId,
            referenceId: created.document.referenceId,
            location,
            documentSchemaName: schema.name,
            displayName: "welcome-v2",
            title: "welcome v2",
            plainText: "hello again",
          });
          return { schema, document };
        }),
      );

      expect(updated.document.name).toEqual(created.document.name);
      expect(updated.document.displayName).toEqual("welcome-v2");
      expect(updated.document.plainText).toEqual("hello again");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.document.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
