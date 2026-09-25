import * as GCP from "@/GCP";
import { Document, DocumentProvider } from "@/GCP/Firestore/Document.ts";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: DocumentProvider().pipe(Layer.provideMerge(GCP.providers())),
});

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
const defaultDoc = `projects/${project}/databases/(default)/documents/_alchemy/alchemy-missing`;

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabasesDocuments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsDatabasesDocuments on a missing document fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.getProjectsDatabasesDocuments({ name: defaultDoc }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_FIRESTORE_DOCUMENT)(
  "createDocumentProjectsDatabasesDocuments without a database fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.createDocumentProjectsDatabasesDocuments({
          parent: `projects/${project}/databases/(default)/documents`,
          collectionId: "_alchemy",
          documentId: "alchemy-probe",
          body: { fields: { env: { stringValue: "probe" } } },
        }),
      );
      expect(["NotFound", "BadRequest", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds ||
    !!process.env.FAST ||
    !process.env.GCP_TEST_FIRESTORE_DOCUMENT,
)(
  "create, update, and delete a firestore document",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Document("Flag", {
            database: "(default)",
            collectionId: "_alchemy",
            fields: { env: { stringValue: "test" } },
          });
        }),
      );

      expect(created.name).toContain("/documents/");
      expect(created.collectionId).toEqual("_alchemy");
      expect(created.fields.env?.stringValue).toEqual("test");

      const fetched = yield* firestore.getProjectsDatabasesDocuments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fields?.env?.stringValue).toEqual("test");
      expect(fetched.fields?.alchemy_id?.stringValue).toEqual(
        expect.any(String),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Document("Flag", {
            database: "(default)",
            collectionId: "_alchemy",
            documentId: created.documentId,
            fields: {
              env: { stringValue: "prod" },
              role: { stringValue: "flag" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.fields.env?.stringValue).toEqual("prod");
      expect(updated.fields.role?.stringValue).toEqual("flag");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
