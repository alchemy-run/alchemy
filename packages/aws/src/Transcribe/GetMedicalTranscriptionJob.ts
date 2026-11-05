import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `transcribe:GetMedicalTranscriptionJob` — read a medical transcription job's status and transcript location.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetMedicalTranscriptionJob` on `*`.
 *
 * ### Medical Transcription Jobs
 * **Example:** Poll a Medical Transcription Job
 * ```typescript
 * // init
 * const getMedicalTranscriptionJob = yield* AWS.Transcribe.GetMedicalTranscriptionJob();
 *
 * // runtime
 * const { MedicalTranscriptionJob } = yield* getMedicalTranscriptionJob({
 *   MedicalTranscriptionJobName: "my-medical-job",
 * });
 * ```
 *
 * @binding
 */
export interface GetMedicalTranscriptionJob extends Binding.Service<
  GetMedicalTranscriptionJob,
  "AWS.Transcribe.GetMedicalTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.GetMedicalTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.GetMedicalTranscriptionJobResponse,
      transcribe.GetMedicalTranscriptionJobError
    >
  >
> {}
export const GetMedicalTranscriptionJob = Binding.Service<GetMedicalTranscriptionJob>(
  "AWS.Transcribe.GetMedicalTranscriptionJob",
);

export const GetMedicalTranscriptionJobHttp = Layer.effect(
  GetMedicalTranscriptionJob,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.GetMedicalTranscriptionJob",
    operation: transcribe.getMedicalTranscriptionJob,
    actions: ["transcribe:GetMedicalTranscriptionJob"],
  }),
);
