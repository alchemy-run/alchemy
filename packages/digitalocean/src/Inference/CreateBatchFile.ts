import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Registers a batch input file and returns its upload URL. Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const createFile = yield* DigitalOcean.Inference.CreateBatchFile({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const file = yield* createFile({ file_name: "requests.jsonl" });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateBatchFileHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateBatchFile extends Binding.Service<
  CreateBatchFile,
  "DigitalOcean.Inference.CreateBatchFile",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceBatchFileRequest,
    ) => Effect.Effect<
      DO.BatchFileCreateResponse,
      DO.CreateInferenceBatchFileError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateBatchFile = Binding.Service<CreateBatchFile>(
  "DigitalOcean.Inference.CreateBatchFile",
);
