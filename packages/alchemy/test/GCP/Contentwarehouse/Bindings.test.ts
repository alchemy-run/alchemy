import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
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

const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us";
const parent = `projects/${project}/locations/${location}`;

test.provider.skipIf(!runLifecycle)(
  "GetDocumentSchema and GetDocument invoke HTTP bindings",
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
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
          Effect.catchTag("NotFound", () =>
            Effect.succeed({ tag: "NotFound" as const }),
          ),
        );
      if (probe.tag !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.Contentwarehouse.DocumentSchema("Note", {
            location,
            displayName: "binding-note",
            propertyDefinitions: [
              { name: "title", isSearchable: true, textTypeOptions: {} },
            ],
          });
          const document = yield* GCP.Contentwarehouse.Document("Welcome", {
            location,
            documentSchemaName: schema.name,
            displayName: "binding-welcome",
            plainText: "hello binding",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* document.name;
              const getSchema =
                yield* GCP.Contentwarehouse.GetDocumentSchema(schema);
              const getDocument =
                yield* GCP.Contentwarehouse.GetDocument(document);
              return Effect.fn(function* () {
                const liveSchema = yield* getSchema();
                const liveDocument = yield* getDocument();
                return { liveSchema, liveDocument };
              });
            }),
          );
          return {
            schema,
            document,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.liveSchema.name).toEqual(out.schema.name);
      expect(out.probe.liveDocument.name).toEqual(out.document.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
