import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Attestor } from "./Attestor.ts";

export interface ValidateAttestationRequest extends Omit<
  binaryauthorization.ValidateAttestationOccurrenceRequest,
  never
> {}

/**
 * Runtime binding for Binary Authorization
 * `attestors.validateAttestationOccurrence`.
 *
 * Bind this operation to an {@link Attestor} in a Function/Action init
 * phase. Provide {@link ValidateAttestationHttp}.
 *
 * ### Validating an Attestation
 * **Example:** Check a payload against the bound attestor
 * ```typescript
 * const validate = yield* GCP.BinaryAuthorization.ValidateAttestation(
 *   attestor,
 * );
 * const result = yield* validate({
 *   occurrenceNote: note.name,
 *   occurrenceResourceUri: imageUri,
 *   attestation: {
 *     serializedPayload: btoa("payload"),
 *     signatures: [{ publicKeyId: keyId, signature: btoa("sig") }],
 *   },
 * });
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface ValidateAttestation extends Binding.Service<
  ValidateAttestation,
  "GCP.BinaryAuthorization.ValidateAttestation",
  (
    attestor: Attestor,
  ) => Effect.Effect<
    (
      request: ValidateAttestationRequest,
    ) => Effect.Effect<
      binaryauthorization.ValidateAttestationOccurrenceResponse,
      binaryauthorization.ValidateAttestationOccurrenceProjectsAttestorsError,
      RuntimeContext
    >
  >
> {}

export const ValidateAttestation = Binding.Service<ValidateAttestation>(
  "GCP.BinaryAuthorization.ValidateAttestation",
);

/**
 * HTTP implementation of {@link ValidateAttestation}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.ValidateAttestation
 */
export const ValidateAttestationHttp = Layer.effect(
  ValidateAttestation,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const validate = yield* GCPBindings.withCredentials(
      binaryauthorization.validateAttestationOccurrenceProjectsAttestors,
    );
    return Effect.fn(function* (attestor: Attestor) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BinaryAuthorization.ValidateAttestation(${attestor})`({
          iam: [
            grantFor(
              {
                role: "roles/binaryauthorization.attestorsVerifier",
                on: "binaryauthorization.attestor",
              },
              attestor.name,
            ),
          ],
        });
      }
      const project = yield* attestor.project;
      const attestorId = yield* attestor.attestorId;
      const noteReference = yield* attestor.noteReference;
      return Effect.fn(`GCP.BinaryAuthorization.ValidateAttestation(${attestor.LogicalId})`)(
        function* (request: ValidateAttestationRequest) {
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
        },
      );
    });
  }),
);
