import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import OpenAIFunction, {
  BATCH_JSONL,
  BatchDeployment,
  ChatDeployment,
  EmbedDeployment,
  OpenAIAccount,
} from "./fixtures/openai-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Cognitive Services OpenAI Contributor**: the deployer's out-of-band data-plane access. */
const OPENAI_CONTRIBUTOR = "a001fd3d-188f-4b5d-821b-7da978bf7442";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureOpenAIBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* OpenAIFunction;
    const account = yield* OpenAIAccount;
    yield* ChatDeployment;
    yield* EmbedDeployment;
    yield* BatchDeployment;
    // Lets the deployer read the files and batches out of band.
    const deployer = yield* callerObjectId;
    yield* Azure.Authorization.RoleAssignment("OpenAIBindDeployerContributor", {
      scope: account.accountId,
      roleDefinitionId: OPENAI_CONTRIBUTOR,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      accountId: account.accountId,
      subdomain: account.customSubDomainName,
    };
  }),
);

// S0 AI services account + GlobalStandard deployments (per token, $0 idle) + Flex
// Consumption; a few hundred tokens per run (<$0.01), ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** The account's Azure OpenAI endpoint, as the authoring operations take it. */
const endpoint = Effect.map(stack, (outputs) => `https://${outputs.subdomain}.openai.azure.com`);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Retry a deployer data-plane call through the deployer's own role propagation. */
const asDeployer = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Unauthorized" || e._tag === "Forbidden",
      schedule: Schedule.spaced("10 seconds"),
      times: 18,
    }),
    Effect.provide(azure),
  );

/** Read a file as the deployer (`"NotFound"` once it is gone). */
const deployerFile = (fileId: string) =>
  Effect.gen(function* () {
    const url = yield* endpoint;
    return yield* asDeployer(
      authoring.GetFile({ endpoint: url, fileId }).pipe(
        Effect.map((file) => ({ filename: file.filename, purpose: file.purpose })),
        Effect.catchTag("NotFound", () => Effect.succeed("NotFound" as const)),
      ),
    );
  });

/** The batch file the Function uploads once; shared by the read and batch cases. */
const uploaded = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const body = yield* call("/upload");
      expectOk(body);
      return body.result as { id: string; filename: string; purpose: string };
    }),
  ),
);

/** The batch the Function starts once from {@link uploaded}; shared by the batch cases. */
const createdBatch = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const file = yield* uploaded;
      const body = yield* call(`/create-batch?id=${file.id}`);
      expectOk(body);
      return body.result as { id: string; inputFileId: string };
    }),
  ),
);

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<data actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.CognitiveServices/accounts/OpenAI/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe("Azure OpenAI bindings on an Azure Function", { tags: ["provider:azure", "live"] }, () => {
  describe("CognitiveServices.OpenAICreateChatCompletion", () => {
    test(
      "answers a chat prompt; a missing deployment is NotFound",
      Effect.gen(function* () {
        const body = yield* call("/chat");
        expectOk(body);
        expect(body.result.object).toEqual("chat.completion");
        expect(body.result.content.toLowerCase()).toContain("pong");
        expect(body.result.missing).toEqual("NotFound");
      }),
      { timeout: 420_000 },
    );
  });

  describe("CognitiveServices.OpenAICreateEmbedding", () => {
    test(
      "embeds two inputs with the embeddings deployment",
      Effect.gen(function* () {
        const body = yield* call("/embed");
        expectOk(body);
        expect(body.result).toEqual({ count: 2, dimensions: 1536 });
      }),
      { timeout: 300_000 },
    );
  });

  // Completions, image, and audio models are not deployable for every
  // subscription and region: these cases send a well-formed request to the
  // chat deployment and assert the typed rejection it gets past the role.
  describe("CognitiveServices.OpenAICreateCompletion", () => {
    test(
      "a chat deployment rejects the completions operation",
      Effect.gen(function* () {
        const body = yield* call("/completion");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "BadRequest" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICreateImageGeneration", () => {
    test(
      "a chat deployment rejects the image operation",
      Effect.gen(function* () {
        const body = yield* call("/image");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "BadRequest" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICreateTranscription", () => {
    test(
      "sends the audio as multipart; a chat deployment rejects it",
      Effect.gen(function* () {
        const body = yield* call("/transcribe");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "BadRequest" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICreateTranslation", () => {
    test(
      "sends the audio as multipart; a chat deployment rejects it",
      Effect.gen(function* () {
        const body = yield* call("/translate");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "BadRequest" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIListModels", () => {
    test(
      "lists the deployed chat model among the account's models",
      Effect.gen(function* () {
        const body = yield* call("/models");
        expectOk(body);
        expect(body.result.ids).toContain("gpt-4.1-mini-2025-04-14");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetModel", () => {
    test(
      "reads one model; a missing one is NotFound",
      Effect.gen(function* () {
        const body = yield* call("/model?id=gpt-4.1-mini-2025-04-14");
        expectOk(body);
        expect(body.result).toEqual({
          id: "gpt-4.1-mini-2025-04-14",
          chat: true,
          missing: "NotFound",
        });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIUploadFile", () => {
    test(
      "uploads a batch file the deployer reads back",
      Effect.gen(function* () {
        const file = yield* uploaded;
        expect({ filename: file.filename, purpose: file.purpose }).toEqual({
          filename: "alchemy-bind-upload.jsonl",
          purpose: "batch",
        });
        const observed = yield* deployerFile(file.id);
        expect(observed).toEqual({
          filename: "alchemy-bind-upload.jsonl",
          purpose: "batch",
        });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIListFiles", () => {
    test(
      "lists the uploaded batch file",
      Effect.gen(function* () {
        const file = yield* uploaded;
        const body = yield* call("/files");
        expectOk(body);
        expect(body.result.ids).toContain(file.id);
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetFile", () => {
    test(
      "reads the uploaded file; a missing one is NotFound",
      Effect.gen(function* () {
        const file = yield* uploaded;
        const body = yield* call(`/file?id=${file.id}`);
        expectOk(body);
        expect({
          id: body.result.id,
          filename: body.result.filename,
          missing: body.result.missing,
        }).toEqual({ id: file.id, filename: "alchemy-bind-upload.jsonl", missing: "NotFound" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetFileContent", () => {
    test(
      "reads back the uploaded lines",
      Effect.gen(function* () {
        const file = yield* uploaded;
        const body = yield* call(`/file-content?id=${file.id}`);
        expectOk(body);
        expect(body.result.content).toEqual(JSON.parse(BATCH_JSONL));
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIImportFile", () => {
    test(
      "an unreachable content URL is rejected",
      Effect.gen(function* () {
        const body = yield* call("/import");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "BadRequest" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIDeleteFile", () => {
    test(
      "deletes a file the deployer then cannot read",
      Effect.gen(function* () {
        const upload = yield* call("/upload");
        expectOk(upload);
        const body = yield* call(`/delete-file?id=${upload.result.id}`);
        expectOk(body);
        expect(body.result).toEqual({ id: upload.result.id, deleted: true });
        const gone = yield* deployerFile(upload.result.id).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (file) => file === "NotFound",
            times: 10,
          }),
        );
        expect(gone).toEqual("NotFound");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIStartUploadFile", () => {
    test(
      "starts, fills, and completes a multi-part upload into a file",
      Effect.gen(function* () {
        const body = yield* call("/multipart-upload");
        expectOk(body);
        expect(body.result.status).toEqual("completed");
        const observed = yield* deployerFile(body.result.fileId);
        expect(observed).toEqual({
          filename: "alchemy-bind-parts.jsonl",
          purpose: "batch",
        });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIUploadFilePart", () => {
    test(
      "the uploaded part becomes the file's content",
      Effect.gen(function* () {
        const body = yield* call("/multipart-upload");
        expectOk(body);
        const url = yield* endpoint;
        const content = yield* asDeployer(
          authoring.GetFileContent({ endpoint: url, fileId: body.result.fileId }),
        );
        expect(content).toEqual(JSON.parse(BATCH_JSONL));
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICompleteUploadFile", () => {
    test(
      "completing an upload creates the file",
      Effect.gen(function* () {
        const body = yield* call("/multipart-upload");
        expectOk(body);
        expect(body.result.fileId).toMatch(/^file-/);
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICancelUploadFile", () => {
    test(
      "cancels a started upload",
      Effect.gen(function* () {
        const body = yield* call("/cancel-upload");
        expectOk(body);
        expect(body.result).toEqual({ status: "cancelled" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICreateBatch", () => {
    test(
      "starts a batch from the uploaded file the deployer reads back",
      Effect.gen(function* () {
        const file = yield* uploaded;
        const batch = yield* createdBatch;
        expect(batch.inputFileId).toEqual(file.id);
        const url = yield* endpoint;
        const observed = yield* asDeployer(
          authoring.GetBatch({ endpoint: url, batchId: batch.id }),
        );
        expect(observed.input_file_id).toEqual(file.id);
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIListBatch", () => {
    test(
      "lists the created batch",
      Effect.gen(function* () {
        const batch = yield* createdBatch;
        const body = yield* call("/batches");
        expectOk(body);
        expect(body.result.ids).toContain(batch.id);
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetBatch", () => {
    test(
      "reads the created batch; a missing one is NotFound",
      Effect.gen(function* () {
        const file = yield* uploaded;
        const batch = yield* createdBatch;
        const body = yield* call(`/batch?id=${batch.id}`);
        expectOk(body);
        expect(body.result).toEqual({ id: batch.id, inputFileId: file.id, missing: "NotFound" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICancelBatch", () => {
    test(
      "cancels the created batch; a missing one is NotFound",
      Effect.gen(function* () {
        const batch = yield* createdBatch;
        const body = yield* call(`/cancel-batch?id=${batch.id}`);
        expectOk(body);
        expect(body.result).toEqual({ id: batch.id, missing: "NotFound" });
        const url = yield* endpoint;
        const cancelled = yield* asDeployer(
          authoring.GetBatch({ endpoint: url, batchId: batch.id }),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (observed) => observed.status === "cancelled",
            times: 24,
          }),
        );
        expect(cancelled.status).toEqual("cancelled");
      }),
      { timeout: 300_000 },
    );
  });

  // A real fine-tuning job trains for an hour or more and bills per token
  // and per hosting hour: these cases assert the typed rejection of a job or
  // training file that does not exist, past the role.
  describe("CognitiveServices.OpenAIListFineTuning", () => {
    test(
      "lists the account's jobs; reads of a missing job are NotFound",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning");
        expectOk(body);
        expect(body.result).toEqual({
          jobs: 0,
          get: "NotFound",
          events: "NotFound",
          checkpoints: "NotFound",
        });
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetFineTuning", () => {
    test(
      "a missing job is NotFound",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning");
        expectOk(body);
        expect(body.result.get).toEqual("NotFound");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetFineTuningEvents", () => {
    test(
      "a missing job's events are NotFound",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning");
        expectOk(body);
        expect(body.result.events).toEqual("NotFound");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIGetFineTuningCheckpoints", () => {
    test(
      "a missing job's checkpoints are NotFound",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning");
        expectOk(body);
        expect(body.result.checkpoints).toEqual("NotFound");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICreateFineTuning", () => {
    test(
      "a missing training file is rejected",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning-write");
        expectOk(body);
        expect(body.result.create).toEqual("BadRequest");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAICancelFineTuning", () => {
    test(
      "cancelling a missing job is NotFound",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning-write");
        expectOk(body);
        expect(body.result.cancel).toEqual("NotFound");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CognitiveServices.OpenAIDeleteFineTuning", () => {
    test(
      "deleting a missing job succeeds (Azure answers 204)",
      Effect.gen(function* () {
        const body = yield* call("/fine-tuning-delete");
        expectOk(body);
        expect(body.result).toEqual({ deleted: "none" });
      }),
      { timeout: 300_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding's data action, scoped to the bound account",
      Effect.gen(function* () {
        const outputs = yield* stack;
        expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
        const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
        const account = outputs.accountId.toLowerCase();
        expect(grants).toEqual(
          [
            "deployments/chat/completions/action",
            "deployments/completions/action",
            "deployments/embeddings/action",
            "deployments/audio/action",
            "images/generations/action",
            "models/read",
            "files/read",
            "files/write",
            "files/delete",
            "uploads/write",
            "batches/action",
            "batches/read",
            "batches/cancel/action",
            "fine-tunes/read",
            "fine-tunes/write",
            "fine-tunes/delete",
          ]
            .map((action) => `${action} ${account}`)
            .sort(),
        );
      }),
      { timeout: 120_000 },
    );
  });
});

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 18,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
