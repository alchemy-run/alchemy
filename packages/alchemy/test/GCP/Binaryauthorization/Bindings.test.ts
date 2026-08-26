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
  "GetAttestor invokes the HTTP binding",
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
            "ProbeGet",
            Effect.gen(function* () {
              yield* attestor.name;
              const getAttestor =
                yield* GCP.Binaryauthorization.GetAttestor(attestor);
              return Effect.fn(function* () {
                return yield* getAttestor();
              });
            }),
          );
          return { note, attestor, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.attestor.name);
      expect(out.live.userOwnedGrafeasNote?.noteReference).toEqual(
        out.note.name,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !process.env.GCP_TEST_BINAUTHZ_VALIDATE)(
  "ValidateAttestation invokes the HTTP binding",
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
            "ProbeValidate",
            Effect.gen(function* () {
              yield* attestor.attestorId;
              yield* attestor.noteReference;
              const validate =
                yield* GCP.Binaryauthorization.ValidateAttestation(attestor);
              return Effect.fn(function* () {
                return yield* validate({
                  occurrenceResourceUri: TEST_RESOURCE_URI,
                  attestation: TEST_ATTESTATION,
                });
              });
            }),
          );
          return { attestor, result: yield* Probe({}) };
        }),
      );

      expect(["ATTESTATION_NOT_VERIFIABLE", "VERIFIED"]).toContain(
        out.result.result,
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
