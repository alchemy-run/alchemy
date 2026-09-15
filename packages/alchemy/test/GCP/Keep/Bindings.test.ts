import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as keep from "@distilled.cloud/gcp/keep_v1";
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

const probeAccess = () =>
  keep.listNotes({ pageSize: 1, filter: "trashed=false" }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetNote round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.Keep.Note("Scratch", {
            title: "Binding",
            text: "GetNote round-trip",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* note.name;
              const getNote = yield* GCP.Keep.GetNote(note);
              return Effect.fn(function* () {
                return yield* getNote({});
              });
            }),
          );
          return { note, metadata: yield* Probe({}) };
        }),
      );

      expect(out.metadata.name).toEqual(out.note.name);
      expect(out.metadata.title).toContain("[alchemy ");
      expect(out.metadata.body?.text?.text).toEqual("GetNote round-trip");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
