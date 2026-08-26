import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Attestor } from "./Attestor.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import {
  ValidateAttestation,
  type ValidateAttestationRequest,
} from "./ValidateAttestation.ts";

/**
 * HTTP implementation of {@link ValidateAttestation}.
 *
 * @layer
 * @provides GCP.Binaryauthorization.ValidateAttestation
 */
export const ValidateAttestationHttp = Layer.effect(
  ValidateAttestation,
  Effect.gen(function* () {
    const validate =
      yield* binaryauthorization.validateAttestationOccurrenceProjectsAttestors;
    return Effect.fn(function* (attestor: Attestor) {
      yield* bindGcpHost({
        tag: "GCP.Binaryauthorization.ValidateAttestation",
        resource: attestor,
        iam: [
          {
            role: defaultRoleFor("GCP.Binaryauthorization.ValidateAttestation"),
          },
        ],
      });
      const project = yield* attestor.project;
      const attestorId = yield* attestor.attestorId;
      const noteReference = yield* attestor.noteReference;
      return Effect.fn(
        `GCP.Binaryauthorization.ValidateAttestation(${attestor.LogicalId})`,
      )(function* (request: ValidateAttestationRequest) {
        const projectId = yield* project;
        const id = yield* attestorId;
        const occurrenceNote = request.occurrenceNote ?? (yield* noteReference);
        return yield* validate({
          attestor: `projects/${projectId}/attestors/${id}`,
          body: {
            occurrenceResourceUri: request.occurrenceResourceUri,
            occurrenceNote,
            attestation: request.attestation,
          },
        });
      });
    });
  }),
);
