import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
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
import LanguageFunction, { Language } from "./fixtures/language-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Cognitive Services User**: the deployer's out-of-band data-plane access. */
const COGNITIVE_SERVICES_USER = "a97b65f3-24c7-4388-baec-2e87135dc908";

/** Blocklist the blocklist bindings create, read, and delete. */
const BLOCKLIST = "alchemy-lang-bindings";

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
  "AzureLanguageBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* LanguageFunction;
    const account = yield* Language;
    // Lets the deployer read the jobs and blocklists out of band.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("LangBindDeployerUser", {
      scope: account.accountId,
      roleDefinitionId: COGNITIVE_SERVICES_USER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      accountId: account.accountId,
      endpoint: account.endpoint,
    };
  }),
);

// S0 AI services account (pay per call, a few cents of calls) + Flex Consumption; ~$0.05/run, ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** The account endpoint without the trailing slash, as the data-plane operations take it. */
const endpoint = Effect.map(stack, (outputs) => (outputs.endpoint ?? "").replace(/\/+$/, ""));

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
const asDeployer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
    Effect.provide(azure),
  );

/** Poll a job as the deployer until it leaves `notStarted`/`running`/`cancelling`. */
const settled = <A extends { status: string }, E, R>(read: Effect.Effect<A, E, R>) =>
  asDeployer(read).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (job) => !["notStarted", "running", "cancelling"].includes(job.status),
      times: 40,
    }),
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
        .map((a) => a.replace("Microsoft.CognitiveServices/accounts/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Azure AI Language and Content Safety bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("CognitiveServices.AnalyzeText", () => {
      test(
        "scores the sentiment of a document",
        Effect.gen(function* () {
          const body = yield* call("/analyze-text");
          expectOk(body);
          expect(body.result.kind).toEqual("SentimentAnalysisResults");
          expect(body.result.results.documents.map((d: any) => [d.id, d.sentiment])).toEqual([
            ["1", "positive"],
          ]);
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.SubmitAnalyzeTextJob", () => {
      test(
        "submits a key-phrase job the deployer sees succeed",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const body = yield* call("/text-job");
          expectOk(body);
          expect(body.result.jobId).toMatch(/^[0-9a-f-]{36}$/);
          const job = yield* settled(
            lang.AnalyzeTextJobStatus({ endpoint: at, jobId: body.result.jobId }),
          );
          expect({ status: job.status, displayName: job.displayName }).toEqual({
            status: "succeeded",
            displayName: "alchemy-key-phrases",
          });
          const results = job.tasks.items?.[0]?.results as any;
          expect(results.documents[0].keyPhrases).toContain("Azure Functions");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.GetAnalyzeTextJob", () => {
      test(
        "reads a job's status and results",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const submitted = yield* call("/text-job");
          expectOk(submitted);
          const jobId = submitted.result.jobId;
          yield* settled(lang.AnalyzeTextJobStatus({ endpoint: at, jobId }));
          const body = yield* call(`/text-job-status?id=${jobId}`);
          expectOk(body);
          expect({ jobId: body.result.jobId, status: body.result.status }).toEqual({
            jobId,
            status: "succeeded",
          });
          expect(body.result.tasks.items[0].kind).toEqual("KeyPhraseExtractionLROResults");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.CancelAnalyzeTextJob", () => {
      test(
        "cancels a running summarization job",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const body = yield* call("/text-job-cancel");
          expectOk(body);
          const job = yield* settled(
            lang.AnalyzeTextJobStatus({ endpoint: at, jobId: body.result.jobId }),
          );
          expect(job.status).toEqual("cancelled");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.AnalyzeConversations", () => {
      test(
        "is authorized and reaches the (missing) CLU project",
        Effect.gen(function* () {
          const body = yield* call("/analyze-conversations");
          expectOk(body);
          expect(body.result).toEqual("NotFound");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.SubmitAnalyzeConversationsJob", () => {
      test(
        "submits a conversation PII job the deployer sees succeed",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const body = yield* call("/conversation-job");
          expectOk(body);
          const job = yield* settled(
            conversations.AnalyzeConversationsJobStatus({
              endpoint: at,
              jobId: body.result.jobId,
            }),
          );
          expect({ status: job.status, displayName: job.displayName }).toEqual({
            status: "succeeded",
            displayName: "alchemy-conversation-pii",
          });
          const results = job.tasks.items?.[0]?.results as any;
          const redacted = results.conversations[0].conversationItems[0].redactedContent.text;
          expect(redacted).not.toContain("425-555-0100");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.GetAnalyzeConversationsJob", () => {
      test(
        "reads a conversation job's status and results",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const submitted = yield* call("/conversation-job");
          expectOk(submitted);
          const jobId = submitted.result.jobId;
          yield* settled(conversations.AnalyzeConversationsJobStatus({ endpoint: at, jobId }));
          const body = yield* call(`/conversation-job-status?id=${jobId}`);
          expectOk(body);
          expect({ jobId: body.result.jobId, status: body.result.status }).toEqual({
            jobId,
            status: "succeeded",
          });
          expect(body.result.tasks.items[0].kind).toEqual("conversationalPIIResults");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.CancelAnalyzeConversationsJob", () => {
      test(
        "cancels a running conversation summarization job",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const body = yield* call("/conversation-job-cancel");
          expectOk(body);
          const job = yield* settled(
            conversations.AnalyzeConversationsJobStatus({
              endpoint: at,
              jobId: body.result.jobId,
            }),
          );
          expect(job.status).toEqual("cancelled");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.SubmitAnalyzeDocumentsJob", () => {
      test(
        "submits a document job the deployer sees reject the unreadable blob",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const body = yield* call("/documents-job");
          expectOk(body);
          const job = yield* settled(
            documents.AnalyzeDocumentsJobStatus({
              endpoint: at,
              jobId: body.result.jobId,
            }),
          );
          // The job succeeds; its one document fails because the account has
          // no managed identity to read the blob with.
          expect({ status: job.status, displayName: job.displayName }).toEqual({
            status: "succeeded",
            displayName: "alchemy-documents",
          });
          const results = job.tasks.items?.[0]?.results as any;
          expect(results.documents).toEqual([]);
          expect(results.errors.map((e: any) => e.id)).toEqual(["1"]);
          expect(results.errors[0].error.message).toContain("Managed Identity (MI) is not set");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.GetAnalyzeDocumentsJob", () => {
      test(
        "reads a document job's status",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const submitted = yield* call("/documents-job");
          expectOk(submitted);
          const jobId = submitted.result.jobId;
          yield* settled(documents.AnalyzeDocumentsJobStatus({ endpoint: at, jobId }));
          const body = yield* call(`/documents-job-status?id=${jobId}`);
          expectOk(body);
          expect({ jobId: body.result.jobId, status: body.result.status }).toEqual({
            jobId,
            status: "succeeded",
          });
          expect(body.result.tasks.items[0].results.errors[0].id).toEqual("1");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.CancelAnalyzeDocumentsJob", () => {
      test(
        "cancels a document job before it runs",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const body = yield* call("/documents-job-cancel");
          expectOk(body);
          const job = yield* settled(
            documents.AnalyzeDocumentsJobStatus({ endpoint: at, jobId: body.result.jobId }),
          );
          expect(job.status).toEqual("cancelled");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.GetAnswers", () => {
      test(
        "is authorized and reaches the (missing) question answering project",
        Effect.gen(function* () {
          const body = yield* call("/answers");
          expectOk(body);
          expect(body.result).toEqual("NotFound");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.GetAnswersFromText", () => {
      test(
        "answers a question from the records passed in",
        Effect.gen(function* () {
          const body = yield* call("/answers-from-text");
          expectOk(body);
          expect(body.result.answers[0].id).toEqual("1");
          expect(body.result.answers[0].answer).toContain("10 hours");
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.AnalyzeTextSafety", () => {
      test(
        "scores harmless text at severity 0 in every category",
        Effect.gen(function* () {
          const body = yield* call("/safety-text");
          expectOk(body);
          expect(
            body.result.categoriesAnalysis.map((c: any) => [c.category, c.severity]).sort(),
          ).toEqual([
            ["Hate", 0],
            ["SelfHarm", 0],
            ["Sexual", 0],
            ["Violence", 0],
          ]);
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.AnalyzeImageSafety", () => {
      test(
        "scores a blank image at severity 0 in every category",
        Effect.gen(function* () {
          const body = yield* call("/safety-image");
          expectOk(body);
          expect(
            body.result.categoriesAnalysis.map((c: any) => [c.category, c.severity]).sort(),
          ).toEqual([
            ["Hate", 0],
            ["SelfHarm", 0],
            ["Sexual", 0],
            ["Violence", 0],
          ]);
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.DetectTextProtectedMaterial", () => {
      test(
        "finds no protected material in original text",
        Effect.gen(function* () {
          const body = yield* call("/protected-material");
          expectOk(body);
          expect(body.result).toEqual({ protectedMaterialAnalysis: { detected: false } });
        }),
        { timeout: 420_000 },
      );
    });

    describe("CognitiveServices.ShieldPrompt", () => {
      test(
        "flags the jailbreak prompt and not the benign document",
        Effect.gen(function* () {
          const body = yield* call("/shield-prompt");
          expectOk(body);
          expect(body.result).toEqual({
            userPromptAnalysis: { attackDetected: true },
            documentsAnalysis: [{ attackDetected: false }],
          });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Content Safety text blocklists", () => {
      test(
        "CreateOrUpdateTextBlocklist, AddOrUpdateTextBlocklistItems, GetTextBlocklist, ListTextBlocklists, GetTextBlocklistItem, ListTextBlocklistItems, RemoveTextBlocklistItems, DeleteTextBlocklist",
        Effect.gen(function* () {
          const at = yield* endpoint;
          const created = yield* call(`/blocklist-create?name=${BLOCKLIST}`);
          expectOk(created);
          expect(created.result.blocklist).toEqual({
            blocklistName: BLOCKLIST,
            description: "Created by LanguageFunction",
          });
          const [itemId] = created.result.itemIds as string[];
          expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
          const observed = yield* asDeployer(
            contentSafety.GetTextBlocklistTextBlocklistItem({
              endpoint: at,
              blocklistName: BLOCKLIST,
              blocklistItemId: itemId!,
            }),
          );
          expect(observed.text).toEqual("zorblax");

          const read = yield* call(`/blocklist-read?name=${BLOCKLIST}&id=${itemId}`);
          expectOk(read);
          expect(read.result).toEqual({
            description: "Created by LanguageFunction",
            listed: true,
            item: "zorblax",
            items: ["zorblax"],
            matches: ["zorblax"],
          });

          const removed = yield* call(`/blocklist-remove-item?name=${BLOCKLIST}&id=${itemId}`);
          expectOk(removed);
          const items = yield* asDeployer(
            contentSafety.ListTextBlocklistTextBlocklistItems({
              endpoint: at,
              blocklistName: BLOCKLIST,
            }),
          );
          expect(items.value).toEqual([]);

          const deleted = yield* call(`/blocklist-delete?name=${BLOCKLIST}`);
          expectOk(deleted);
          const remaining = yield* asDeployer(
            contentSafety.ListTextBlocklistTextBlocklists({ endpoint: at }),
          );
          expect(remaining.value.map((b) => b.blocklistName)).not.toContain(BLOCKLIST);
        }),
        { timeout: 600_000 },
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
              "Language/analyze-text/action",
              "Language/analyze-text/jobs/action",
              "Language/analyze-text/jobs/read",
              "Language/analyze-text/jobscancel/action",
              "Language/analyze-conversations/action",
              "Language/analyze-conversations/jobs/action",
              "Language/analyze-conversations/jobs/read",
              "Language/analyze-conversations/jobscancel/action",
              "Language/analyze-documents/jobs/action",
              "Language/analyze-documents/jobs/read",
              "Language/analyze-documents/jobscancel/action",
              "Language/query-knowledgebases/action",
              "Language/query-text/action",
              "ContentSafety/text:analyze/action",
              "ContentSafety/image:analyze/action",
              "ContentSafety/text:detectprotectedmaterial/action",
              "ContentSafety/text:shieldprompt/action",
              "ContentSafety/text/blocklists/read",
              "ContentSafety/text/blocklists/blockitems/read",
              "ContentSafety/text/blocklists/write",
              "ContentSafety/text/blocklists/delete",
            ]
              .map((action) => `${action} ${account}`)
              .sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then check every role assigned to the Function's identity is gone.
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
