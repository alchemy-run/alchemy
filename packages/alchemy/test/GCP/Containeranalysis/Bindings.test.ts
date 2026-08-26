import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  TEST_ATTESTATION,
  TEST_RESOURCE_URI,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "GetNote and GetOccurrence invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.Containeranalysis.Note("Authority", {
            shortDescription: "binding attestor",
            attestation: { hint: { humanReadableName: "Alchemy Bind" } },
          });
          const occurrence = yield* GCP.Containeranalysis.Occurrence("Signed", {
            noteName: note.name,
            resourceUri: TEST_RESOURCE_URI,
            attestation: TEST_ATTESTATION,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* occurrence.name;
              const getNote = yield* GCP.Containeranalysis.GetNote(note);
              const getOccurrence =
                yield* GCP.Containeranalysis.GetOccurrence(occurrence);
              return Effect.fn(function* () {
                const liveNote = yield* getNote();
                const liveOccurrence = yield* getOccurrence();
                return { liveNote, liveOccurrence };
              });
            }),
          );
          return { note, occurrence, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.liveNote.name).toEqual(out.note.name);
      expect(out.probe.liveNote.kind).toEqual("ATTESTATION");
      expect(out.probe.liveOccurrence.name).toEqual(out.occurrence.name);
      expect(out.probe.liveOccurrence.noteName).toEqual(out.note.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
