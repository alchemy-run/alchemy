import * as Azure from "@alchemy.run/azure";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** The service runs batch jobs as its own identity, so it has one. */
export const Deid = Azure.HealthDataAIServices.DeidService("DeidBindingsService", {
  identity: { type: "SystemAssigned" },
});

export const Data = Azure.Storage.StorageAccount("DeidBindingsData");

export const Documents = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("DeidBindingsDocs", {
    storageAccount: account.storageAccountName,
  });
});

/** The service reads the job's input and writes its output with its own identity. */
export const DeidStorageAccess = Effect.gen(function* () {
  const deid = yield* Deid;
  const documents = yield* Documents;
  return yield* Azure.Authorization.RoleAssignment("DeidBindingsStorageAccess", {
    scope: documents.containerId,
    roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
    principalId: deid.principalId.pipe(Output.map((id) => id ?? "")),
    principalType: "ServicePrincipal",
  });
});

/** The text the realtime routes de-identify. */
export const TEXT = "Patient John Smith was seen at Contoso Hospital on 2024-01-05.";
/** The job the batch routes create, read, cancel, and delete. */
export const JOB = "alchemy-bindings-job";
/** The document the job processes. */
export const NOTE = "in/note.txt";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every de-identification binding
 * on a managed-identity host, one route per binding.
 */
export default class DeidBindingsFunction extends Azure.Functions.Function<DeidBindingsFunction>()(
  "DeidBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const deid = yield* Deid;
    const account = yield* Data;
    const documents = yield* Documents;
    yield* DeidStorageAccess;

    const deidentifyText = yield* Azure.HealthDataAIServices.DeidentifyText(deid);
    const deidentifyDocuments = yield* Azure.HealthDataAIServices.DeidentifyDocuments(deid);
    const getJob = yield* Azure.HealthDataAIServices.GetJob(deid);
    const listJobs = yield* Azure.HealthDataAIServices.ListJobs(deid);
    const listJobDocuments = yield* Azure.HealthDataAIServices.ListJobDocuments(deid);
    const cancelJob = yield* Azure.HealthDataAIServices.CancelJob(deid);
    const deleteJob = yield* Azure.HealthDataAIServices.DeleteJob(deid);
    // Seeds the job's input document.
    const blobs = yield* Azure.Storage.BlobContainerWrite(documents);
    const accountName = yield* account.storageAccountName;
    const containerName = yield* documents.containerName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/text/tag":
            return yield* respond(
              Effect.map(deidentifyText({ inputText: TEXT, operation: "Tag" }), (result) => ({
                categories: (result.taggerResult?.entities ?? []).map((e) => e.category).sort(),
              })),
            );
          case "/text/redact":
            return yield* respond(
              Effect.map(deidentifyText({ inputText: TEXT, operation: "Redact" }), (result) => ({
                outputText: result.outputText,
              })),
            );
          case "/seed":
            return yield* respond(
              Effect.as(blobs.put(NOTE, TEXT, { contentType: "text/plain" }), { seeded: NOTE }),
            );
          case "/job/create":
            return yield* respond(
              Effect.gen(function* () {
                const name = yield* accountName;
                const container = yield* containerName;
                const location = `https://${name}.blob.core.windows.net/${container}`;
                const job = yield* deidentifyDocuments({
                  name: JOB,
                  operation: "Surrogate",
                  sourceLocation: { location, prefix: "in/" },
                  targetLocation: { location, prefix: "out/", overwrite: true },
                });
                return { name: job.name, operation: job.operation };
              }),
            );
          case "/job/get":
            return yield* respond(
              Effect.map(getJob({ name: JOB }), (job) => ({
                name: job.name,
                status: job.status,
                prefix: job.sourceLocation.prefix,
              })),
            );
          case "/job/list":
            return yield* respond(
              Effect.map(listJobs(), (page) => ({ names: page.value.map((job) => job.name) })),
            );
          case "/job/documents":
            return yield* respond(
              Effect.map(listJobDocuments({ name: JOB }), (page) => ({
                inputs: page.value.map((d) => new URL(d.input.location).pathname),
              })),
            );
          case "/job/cancel":
            return yield* respond(
              Effect.map(cancelJob({ name: JOB }), (job) => ({ name: job.name })),
            );
          case "/job/delete":
            return yield* respond(Effect.as(deleteJob({ name: JOB }), { deleted: JOB }));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.HealthDataAIServices.DeidentifyTextHttp,
        Azure.HealthDataAIServices.DeidentifyDocumentsHttp,
        Azure.HealthDataAIServices.GetJobHttp,
        Azure.HealthDataAIServices.ListJobsHttp,
        Azure.HealthDataAIServices.ListJobDocumentsHttp,
        Azure.HealthDataAIServices.CancelJobHttp,
        Azure.HealthDataAIServices.DeleteJobHttp,
        Azure.Storage.BlobContainerWriteHttp,
      ),
    ),
  ),
) {}
