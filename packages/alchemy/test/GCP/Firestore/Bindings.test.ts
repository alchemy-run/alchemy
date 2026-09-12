import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
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

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "PatchDocument, GetDocument, and DeleteDocument round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const doc = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("App", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* database.name;
              const patchDocument =
                yield* GCP.Firestore.PatchDocument(database);
              const getDocument = yield* GCP.Firestore.GetDocument(database);
              const deleteDocument =
                yield* GCP.Firestore.DeleteDocument(database);
              return Effect.fn(function* () {
                yield* patchDocument({
                  documentPath: "users/alice",
                  body: { fields: { name: { stringValue: "Alice" } } },
                });
                const live = yield* getDocument({
                  documentPath: "users/alice",
                });
                yield* deleteDocument({ documentPath: "users/alice" });
                return live;
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(doc.fields?.name?.stringValue).toEqual("Alice");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
