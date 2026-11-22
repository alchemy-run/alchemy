import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Name of the chat deployment (the model ID clients send). */
export const CHAT = "alchemy-bind-chat";
/** Name of the embeddings deployment. */
export const EMBED = "alchemy-bind-embed";
/** Name of the `GlobalBatch` deployment batch jobs run on. */
export const BATCH = "alchemy-bind-batch";
/** A deployment the account does not have. */
export const MISSING_DEPLOYMENT = "alchemy-bind-missing";
/** IDs no batch, file, or fine-tuning job has. */
export const MISSING_BATCH = "batch_00000000-0000-0000-0000-000000000000";
export const MISSING_FILE = "file-00000000000000000000000000000000";
export const MISSING_JOB = "ftjob-00000000000000000000000000000000";

/** One batch request against the batch deployment (JSON Lines). */
export const BATCH_JSONL = `${JSON.stringify({
  custom_id: "task-1",
  method: "POST",
  url: "/chat/completions",
  body: { model: BATCH, messages: [{ role: "user", content: "Say hi" }], max_tokens: 5 },
})}\n`;

/** AI services account (S0, pay per call: $0 idle). */
export const OpenAIAccount = Azure.CognitiveServices.Account("OpenAIBindAccount", {
  location: "eastus",
});

export const ChatDeployment = Effect.gen(function* () {
  const account = yield* OpenAIAccount;
  return yield* Azure.CognitiveServices.Deployment("OpenAIBindChat", {
    account: account.accountName,
    name: CHAT,
    model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
    sku: { name: "GlobalStandard", capacity: 1 },
  });
});

export const EmbedDeployment = Effect.gen(function* () {
  const account = yield* OpenAIAccount;
  yield* ChatDeployment;
  return yield* Azure.CognitiveServices.Deployment("OpenAIBindEmbed", {
    account: account.accountName,
    name: EMBED,
    model: { format: "OpenAI", name: "text-embedding-3-small", version: "1" },
    sku: { name: "GlobalStandard", capacity: 1 },
  });
});

/** Batch jobs only run on a batch SKU; billed per token like the others. */
export const BatchDeployment = Effect.gen(function* () {
  const account = yield* OpenAIAccount;
  yield* EmbedDeployment;
  return yield* Azure.CognitiveServices.Deployment("OpenAIBindBatch", {
    account: account.accountName,
    name: BATCH,
    model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
    sku: { name: "GlobalBatch", capacity: 50 },
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** Fail with the tag when an expected rejection is still the role-propagation `Unauthorized`. */
const rejection = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  failureTag(effect).pipe(
    Effect.flatMap((tag) =>
      tag === "Unauthorized" || tag === "Forbidden"
        ? Effect.fail(new Error(`still ${tag} (role propagation)`))
        : Effect.succeed(tag),
    ),
  );

/** 0.1 s of 16 kHz mono 16-bit silence as a WAV file. */
const silenceWav = Effect.sync(() => {
  const samples = 1600;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return new File([view.buffer], "silence.wav", { type: "audio/wav" });
});

const batchFile = (name: string) =>
  Effect.sync(() => new File([BATCH_JSONL], name, { type: "application/jsonl" }));

/**
 * Effect-native Azure Function exercising every Azure OpenAI binding on a
 * managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the Azure
 * error.
 */
export default class OpenAIFunction extends Azure.Functions.Function<OpenAIFunction>()(
  "OpenAIBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* OpenAIAccount;
    yield* ChatDeployment;
    yield* EmbedDeployment;
    yield* BatchDeployment;

    const chat = yield* Azure.CognitiveServices.OpenAICreateChatCompletion(account);
    const complete = yield* Azure.CognitiveServices.OpenAICreateCompletion(account);
    const embed = yield* Azure.CognitiveServices.OpenAICreateEmbedding(account);
    const generateImage = yield* Azure.CognitiveServices.OpenAICreateImageGeneration(account);
    const transcribe = yield* Azure.CognitiveServices.OpenAICreateTranscription(account);
    const translate = yield* Azure.CognitiveServices.OpenAICreateTranslation(account);
    const listModels = yield* Azure.CognitiveServices.OpenAIListModels(account);
    const getModel = yield* Azure.CognitiveServices.OpenAIGetModel(account);
    const listFiles = yield* Azure.CognitiveServices.OpenAIListFiles(account);
    const getFile = yield* Azure.CognitiveServices.OpenAIGetFile(account);
    const getFileContent = yield* Azure.CognitiveServices.OpenAIGetFileContent(account);
    const uploadFile = yield* Azure.CognitiveServices.OpenAIUploadFile(account);
    const importFile = yield* Azure.CognitiveServices.OpenAIImportFile(account);
    const deleteFile = yield* Azure.CognitiveServices.OpenAIDeleteFile(account);
    const startUpload = yield* Azure.CognitiveServices.OpenAIStartUploadFile(account);
    const uploadPart = yield* Azure.CognitiveServices.OpenAIUploadFilePart(account);
    const completeUpload = yield* Azure.CognitiveServices.OpenAICompleteUploadFile(account);
    const cancelUpload = yield* Azure.CognitiveServices.OpenAICancelUploadFile(account);
    const listBatches = yield* Azure.CognitiveServices.OpenAIListBatch(account);
    const createBatch = yield* Azure.CognitiveServices.OpenAICreateBatch(account);
    const getBatch = yield* Azure.CognitiveServices.OpenAIGetBatch(account);
    const cancelBatch = yield* Azure.CognitiveServices.OpenAICancelBatch(account);
    const listFineTuning = yield* Azure.CognitiveServices.OpenAIListFineTuning(account);
    const getFineTuning = yield* Azure.CognitiveServices.OpenAIGetFineTuning(account);
    const getFineTuningEvents = yield* Azure.CognitiveServices.OpenAIGetFineTuningEvents(account);
    const getFineTuningCheckpoints =
      yield* Azure.CognitiveServices.OpenAIGetFineTuningCheckpoints(account);
    const createFineTuning = yield* Azure.CognitiveServices.OpenAICreateFineTuning(account);
    const cancelFineTuning = yield* Azure.CognitiveServices.OpenAICancelFineTuning(account);
    const deleteFineTuning = yield* Azure.CognitiveServices.OpenAIDeleteFineTuning(account);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        switch (url.pathname) {
          case "/chat":
            return yield* respond(
              Effect.gen(function* () {
                const reply = yield* chat({
                  deploymentId: CHAT,
                  messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
                  max_tokens: 5,
                  temperature: 0,
                });
                const missing = yield* rejection(
                  chat({
                    deploymentId: MISSING_DEPLOYMENT,
                    messages: [{ role: "user", content: "hi" }],
                  }),
                );
                const choice = reply.choices[0];
                const content = choice && "message" in choice ? choice.message.content : undefined;
                return { object: reply.object, content, missing };
              }),
            );
          case "/completion":
            return yield* respond(
              Effect.map(
                rejection(complete({ deploymentId: CHAT, prompt: "Once upon", max_tokens: 1 })),
                (rejected) => ({ rejected }),
              ),
            );
          case "/embed":
            return yield* respond(
              Effect.map(embed({ deploymentId: EMBED, input: ["hello", "world"] }), (result) => ({
                count: result.data.length,
                dimensions: result.data[0]?.embedding.length,
              })),
            );
          case "/image":
            return yield* respond(
              Effect.map(
                rejection(generateImage({ deploymentId: CHAT, prompt: "a red fox", n: 1 })),
                (rejected) => ({ rejected }),
              ),
            );
          case "/transcribe":
            return yield* respond(
              Effect.gen(function* () {
                const file = yield* silenceWav;
                return { rejected: yield* rejection(transcribe({ deploymentId: CHAT, file })) };
              }),
            );
          case "/translate":
            return yield* respond(
              Effect.gen(function* () {
                const file = yield* silenceWav;
                return { rejected: yield* rejection(translate({ deploymentId: CHAT, file })) };
              }),
            );
          case "/models":
            return yield* respond(
              Effect.map(listModels(), (list) => ({
                ids: (list.data ?? []).map((model) => model.id),
              })),
            );
          case "/model":
            return yield* respond(
              Effect.gen(function* () {
                const model = yield* getModel({ modelId: id });
                const missing = yield* rejection(getModel({ modelId: "alchemy-no-such-model" }));
                return { id: model.id, chat: model.capabilities.chat_completion, missing };
              }),
            );
          case "/upload":
            return yield* respond(
              Effect.gen(function* () {
                const file = yield* batchFile("alchemy-bind-upload.jsonl");
                const uploaded = yield* uploadFile({ purpose: "batch", file });
                return { id: uploaded.id, filename: uploaded.filename, purpose: uploaded.purpose };
              }),
            );
          case "/files":
            return yield* respond(
              Effect.map(listFiles({ purpose: "batch" }), (list) => ({
                ids: (list.data ?? []).map((file) => file.id),
              })),
            );
          case "/file":
            return yield* respond(
              Effect.gen(function* () {
                const file = yield* getFile({ fileId: id });
                const missing = yield* rejection(getFile({ fileId: MISSING_FILE }));
                return { id: file.id, filename: file.filename, status: file.status, missing };
              }),
            );
          case "/file-content":
            return yield* respond(
              Effect.map(getFileContent({ fileId: id }), (content) => ({ content })),
            );
          case "/import":
            return yield* respond(
              Effect.map(
                rejection(
                  importFile({
                    filename: "alchemy-bind-import.jsonl",
                    content_url: "https://alchemy-bind.invalid/import.jsonl",
                  }),
                ),
                (rejected) => ({ rejected }),
              ),
            );
          case "/delete-file":
            return yield* respond(
              Effect.map(deleteFile({ fileId: id }), (deleted) => ({
                id: deleted.id,
                deleted: deleted.deleted,
              })),
            );
          case "/multipart-upload":
            return yield* respond(
              Effect.gen(function* () {
                const bytes = new TextEncoder().encode(BATCH_JSONL);
                const upload = yield* startUpload({
                  purpose: "batch",
                  filename: "alchemy-bind-parts.jsonl",
                  bytes: bytes.byteLength,
                  mime_type: "application/jsonl",
                });
                const part = yield* uploadPart({ uploadId: upload.id!, data: new Blob([bytes]) });
                const done = yield* completeUpload({ uploadId: upload.id!, part_ids: [part.id!] });
                return { status: done.status, fileId: done.file?.id };
              }),
            );
          case "/cancel-upload":
            return yield* respond(
              Effect.gen(function* () {
                const upload = yield* startUpload({
                  purpose: "batch",
                  filename: "alchemy-bind-cancelled.jsonl",
                  bytes: 10,
                  mime_type: "application/jsonl",
                });
                const cancelled = yield* cancelUpload({ uploadId: upload.id! });
                return { status: cancelled.status };
              }),
            );
          case "/create-batch":
            return yield* respond(
              Effect.map(createBatch({ input_file_id: id, completion_window: "24h" }), (batch) => ({
                id: batch.id,
                inputFileId: batch.input_file_id,
              })),
            );
          case "/batches":
            return yield* respond(
              Effect.map(listBatches({ limit: 20 }), (list) => ({
                ids: (list.data ?? []).map((batch) => batch.id),
              })),
            );
          case "/batch":
            return yield* respond(
              Effect.gen(function* () {
                const batch = yield* getBatch({ batchId: id });
                const missing = yield* rejection(getBatch({ batchId: MISSING_BATCH }));
                return { id: batch.id, inputFileId: batch.input_file_id, missing };
              }),
            );
          case "/cancel-batch":
            return yield* respond(
              Effect.gen(function* () {
                const batch = yield* cancelBatch({ batchId: id });
                const missing = yield* rejection(cancelBatch({ batchId: MISSING_BATCH }));
                return { id: batch.id, missing };
              }),
            );
          case "/fine-tuning":
            return yield* respond(
              Effect.gen(function* () {
                const list = yield* listFineTuning({ limit: 10 });
                const get = yield* rejection(getFineTuning({ fineTuningJobId: MISSING_JOB }));
                const events = yield* rejection(
                  getFineTuningEvents({ fineTuningJobId: MISSING_JOB }),
                );
                const checkpoints = yield* rejection(
                  getFineTuningCheckpoints({ fineTuningJobId: MISSING_JOB }),
                );
                return { jobs: (list.data ?? []).length, get, events, checkpoints };
              }),
            );
          case "/fine-tuning-write":
            return yield* respond(
              Effect.gen(function* () {
                const create = yield* rejection(
                  createFineTuning({
                    model: "gpt-4.1-mini-2025-04-14",
                    training_file: MISSING_FILE,
                  }),
                );
                const cancel = yield* rejection(cancelFineTuning({ fineTuningJobId: MISSING_JOB }));
                return { create, cancel };
              }),
            );
          case "/fine-tuning-delete":
            return yield* respond(
              Effect.map(
                rejection(deleteFineTuning({ fineTuningJobId: MISSING_JOB })),
                (deleted) => ({ deleted }),
              ),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.CognitiveServices.OpenAICreateChatCompletionHttp,
        Azure.CognitiveServices.OpenAICreateCompletionHttp,
        Azure.CognitiveServices.OpenAICreateEmbeddingHttp,
        Azure.CognitiveServices.OpenAICreateImageGenerationHttp,
        Azure.CognitiveServices.OpenAICreateTranscriptionHttp,
        Azure.CognitiveServices.OpenAICreateTranslationHttp,
        Azure.CognitiveServices.OpenAIListModelsHttp,
        Azure.CognitiveServices.OpenAIGetModelHttp,
        Azure.CognitiveServices.OpenAIListFilesHttp,
        Azure.CognitiveServices.OpenAIGetFileHttp,
        Azure.CognitiveServices.OpenAIGetFileContentHttp,
        Azure.CognitiveServices.OpenAIUploadFileHttp,
        Azure.CognitiveServices.OpenAIImportFileHttp,
        Azure.CognitiveServices.OpenAIDeleteFileHttp,
        Azure.CognitiveServices.OpenAIStartUploadFileHttp,
        Azure.CognitiveServices.OpenAIUploadFilePartHttp,
        Azure.CognitiveServices.OpenAICompleteUploadFileHttp,
        Azure.CognitiveServices.OpenAICancelUploadFileHttp,
        Azure.CognitiveServices.OpenAIListBatchHttp,
        Azure.CognitiveServices.OpenAICreateBatchHttp,
        Azure.CognitiveServices.OpenAIGetBatchHttp,
        Azure.CognitiveServices.OpenAICancelBatchHttp,
        Azure.CognitiveServices.OpenAIListFineTuningHttp,
        Azure.CognitiveServices.OpenAIGetFineTuningHttp,
        Azure.CognitiveServices.OpenAIGetFineTuningEventsHttp,
        Azure.CognitiveServices.OpenAIGetFineTuningCheckpointsHttp,
        Azure.CognitiveServices.OpenAICreateFineTuningHttp,
        Azure.CognitiveServices.OpenAICancelFineTuningHttp,
        Azure.CognitiveServices.OpenAIDeleteFineTuningHttp,
      ),
    ),
  ),
) {}
