import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  TEST_ATTESTATION,
  TEST_POD,
  TEST_RESOURCE_URI,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "GetAttestor and ValidateAttestation invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const note = yield* GCP.Containeranalysis.Note("Authority", {
            shortDescription: "binding attestor",
            attestation: { hint: { humanReadableName: "Alchemy Bind" } },
          });
          const attestor = yield* GCP.Binaryauthorization.Attestor("Qa", {
            noteReference: note.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* attestor.name;
              const getAttestor =
                yield* GCP.Binaryauthorization.GetAttestor(attestor);
              const validate =
                yield* GCP.Binaryauthorization.ValidateAttestation(attestor);
              return Effect.fn(function* () {
                const live = yield* getAttestor();
                const result = yield* validate({
                  occurrenceResourceUri: TEST_RESOURCE_URI,
                  attestation: TEST_ATTESTATION,
                });
                return { live, result };
              });
            }),
          );
          return { note, attestor, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.attestor.name);
      expect(out.probe.live.userOwnedGrafeasNote?.noteReference).toEqual(
        out.note.name,
      );
      expect(["ATTESTATION_NOT_VERIFIABLE", "VERIFIED"]).toContain(
        out.probe.result.result,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "GetPlatformsPolicy and EvaluateGkePolicy invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Binaryauthorization.PlatformsPolicy(
            "Default",
            {
              gkePolicy: {},
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* policy.name;
              const getPolicy =
                yield* GCP.Binaryauthorization.GetPlatformsPolicy(policy);
              const evaluate =
                yield* GCP.Binaryauthorization.EvaluateGkePolicy(policy);
              return Effect.fn(function* () {
                const live = yield* getPolicy();
                const result = yield* evaluate({ resource: TEST_POD });
                return { live, result };
              });
            }),
          );
          return { policy, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.policy.name);
      expect(["CONFORMANT", "NON_CONFORMANT", "ERROR"]).toContain(
        out.probe.result.verdict,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
