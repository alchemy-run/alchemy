import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as agents from "@distilled.cloud/azure/ai-agents";
import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as face from "@distilled.cloud/azure/ai-face";
import * as vision from "@distilled.cloud/azure/ai-image-analysis";
import * as projects from "@distilled.cloud/azure/ai-projects";
import * as authorization from "@distilled.cloud/azure/authorization";
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
import AiBindingsFunction, {
  AiAccount,
  AiFaceAccount,
  AiModel,
  AiProject,
  FACES_URL,
  MODEL,
  TEXT_URL,
} from "./fixtures/ai-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Cognitive Services User**: the deployer's out-of-band data-plane access. */
const COGNITIVE_SERVICES_USER = "a97b65f3-24c7-4388-baec-2e87135dc908";

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
  "AzureAIBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AiBindingsFunction;
    const account = yield* AiAccount;
    const faceAccount = yield* AiFaceAccount;
    const project = yield* AiProject;
    const model = yield* AiModel;
    // Lets the deployer verify each binding's effect through the data planes.
    const deployer = yield* callerObjectId;
    yield* Azure.Authorization.RoleAssignment("AiDeployerCognitiveServicesUser", {
      scope: account.accountId,
      roleDefinitionId: COGNITIVE_SERVICES_USER,
      principalId: deployer,
    });
    yield* Azure.Authorization.RoleAssignment("AiDeployerFaceCognitiveServicesUser", {
      scope: faceAccount.accountId,
      roleDefinitionId: COGNITIVE_SERVICES_USER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      accountId: account.accountId,
      accountEndpoint: account.endpoint,
      faceAccountId: faceAccount.accountId,
      faceEndpoint: faceAccount.endpoint,
      projectId: project.projectId,
      projectEndpoints: project.endpoints,
      modelName: model.deploymentName,
    };
  }),
);

// ~$0.05/run (S0 AIServices pay-per-call, a few gpt-4.1-mini tokens,
// Flex Consumption); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

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

/** Retry a deployer data-plane call through the deployer's role propagation. */
const asDeployer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
    Effect.provide(azure),
  );

const projectEndpoint = Effect.map(
  stack,
  ({ projectEndpoints }) => (projectEndpoints as Record<string, string>)["AI Foundry API"] ?? "",
);
const accountEndpoint = Effect.map(stack, ({ accountEndpoint }) => accountEndpoint ?? "");
const faceEndpoint = Effect.map(stack, ({ faceEndpoint }) => faceEndpoint ?? "");

/** Agents the deployer sees in the project. */
const deployerAgentIds = Effect.gen(function* () {
  const endpoint = yield* projectEndpoint;
  const page = yield* asDeployer(agents.ListAgents({ endpoint, limit: 100 }));
  return page.data.map((agent) => agent.id);
});

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
  "Azure AI data-plane bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("CognitiveServices.CreateAgent / GetAgent / ListAgents / UpdateAgent / DeleteAgent", () => {
      test(
        "creates, reads, lists, renames, and deletes an agent",
        Effect.gen(function* () {
          const endpoint = yield* projectEndpoint;
          const created = yield* call("/agent/create?name=alchemy-ai-bindings");
          expectOk(created);
          const id: string = created.result.id;
          expect(id).toMatch(/^asst_/);
          expect(created.result).toEqual({ id, name: "alchemy-ai-bindings", model: MODEL });

          const observed = yield* asDeployer(agents.GetAgent({ endpoint, assistantId: id }));
          expect(observed.name).toEqual("alchemy-ai-bindings");

          const got = yield* call(`/agent/get?id=${id}`);
          expectOk(got);
          expect(got.result).toEqual({ id, name: "alchemy-ai-bindings" });

          const listed = yield* call("/agent/list");
          expectOk(listed);
          expect(listed.result.ids).toContain(id);

          const updated = yield* call(`/agent/update?id=${id}&name=alchemy-ai-renamed`);
          expectOk(updated);
          expect(updated.result).toEqual({ id, name: "alchemy-ai-renamed" });
          const renamed = yield* asDeployer(agents.GetAgent({ endpoint, assistantId: id }));
          expect(renamed.name).toEqual("alchemy-ai-renamed");

          const deleted = yield* call(`/agent/delete?id=${id}`);
          expectOk(deleted);
          expect(deleted.result).toEqual({ deleted: true });
          expect(yield* deployerAgentIds).not.toContain(id);
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.CreateAgentThread / CreateAgentMessage / CreateAgentRun / GetAgentRun / ListAgentMessages / DeleteAgentThread", () => {
      test(
        "runs an agent on a thread and reads its reply",
        Effect.gen(function* () {
          const endpoint = yield* projectEndpoint;
          const agent = yield* call("/agent/create?name=alchemy-ai-runner");
          expectOk(agent);
          const agentId: string = agent.result.id;

          const thread = yield* call("/thread/create");
          expectOk(thread);
          const threadId: string = thread.result.id;
          expect(threadId).toMatch(/^thread_/);

          const message = yield* call(`/message/create?thread=${threadId}`);
          expectOk(message);
          expect(message.result.role).toEqual("user");

          const run = yield* call(`/run/create?thread=${threadId}&agent=${agentId}`);
          expectOk(run);
          const runId: string = run.result.id;
          expect(runId).toMatch(/^run_/);

          const finished = yield* call(`/run/get?thread=${threadId}&run=${runId}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (body) =>
                !body.ok || !["queued", "in_progress"].includes(body.result.status as string),
              times: 20,
            }),
          );
          expectOk(finished);
          expect(finished.result).toEqual({ status: "completed" });

          const listed = yield* call(`/message/list?thread=${threadId}`);
          expectOk(listed);
          const messages = listed.result.messages as { role: string; text: string }[];
          expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
          expect(messages[0]!.text).toEqual("ping");
          expect(messages[1]!.text.toLowerCase()).toContain("pong");

          // Out of band: the deployer sees the same conversation.
          const observed = yield* asDeployer(
            agents.ListMessageMessages({ endpoint, threadId, order: "asc" }),
          );
          expect(
            observed.data.map((m) => m.content.map((item) => item.text?.value ?? "").join("")),
          ).toEqual(messages.map((m) => m.text));

          const deleted = yield* call(`/thread/delete?id=${threadId}`);
          expectOk(deleted);
          expect(deleted.result).toEqual({ deleted: true });
          expectOk(yield* call(`/agent/delete?id=${agentId}`));
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.ListProjectDeployments / GetProjectDeployment", () => {
      test(
        "lists and reads the model deployment",
        Effect.gen(function* () {
          const endpoint = yield* projectEndpoint;
          const listed = yield* call("/project/deployments");
          expectOk(listed);
          expect(listed.result.names).toContain(MODEL);
          const observed = yield* asDeployer(projects.ListDeployments({ endpoint }));
          expect([...listed.result.names].sort()).toEqual(observed.value.map((d) => d.name).sort());

          const got = yield* call("/project/deployment");
          expectOk(got);
          expect(got.result).toEqual({ name: MODEL, type: "ModelDeployment" });
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.ListProjectConnections", () => {
      test(
        "lists the project's connections",
        Effect.gen(function* () {
          const endpoint = yield* projectEndpoint;
          const listed = yield* call("/project/connections");
          expectOk(listed);
          const observed = yield* asDeployer(projects.ListConnections({ endpoint }));
          expect([...listed.result.names].sort()).toEqual(observed.value.map((c) => c.name).sort());
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.AnalyzeDocument / GetDocumentAnalyzeResult", () => {
      test(
        "reads the text of a document with prebuilt-read",
        Effect.gen(function* () {
          const endpoint = yield* accountEndpoint;
          const accepted = yield* call("/document/analyze");
          expectOk(accepted);
          const resultId: string = accepted.result.resultId;
          expect(resultId).toMatch(/^[0-9a-f-]{36}$/);

          const result = yield* call(`/document/result?id=${resultId}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (body) => !body.ok || !["notStarted", "running"].includes(body.result.status),
              times: 20,
            }),
          );
          expectOk(result);
          expect(result.result.status).toEqual("succeeded");
          expect(result.result.content.length).toBeGreaterThan(20);

          const observed = yield* asDeployer(
            documents.GetDocumentModelAnalyzeResult({
              endpoint,
              modelId: "prebuilt-read",
              resultId,
            }),
          );
          expect(observed.analyzeResult?.content).toEqual(result.result.content);
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.ListDocumentModels / GetDocumentModel / GetDocumentIntelligenceResourceDetails", () => {
      test(
        "lists and reads the prebuilt models and the resource details",
        Effect.gen(function* () {
          const endpoint = yield* accountEndpoint;
          const listed = yield* call("/document/models");
          expectOk(listed);
          expect(listed.result.ids).toContain("prebuilt-read");

          const got = yield* call("/document/model");
          expectOk(got);
          expect(got.result).toEqual({ modelId: "prebuilt-read" });

          const info = yield* call("/document/info");
          expectOk(info);
          const observed = yield* asDeployer(
            documents.GetMiscellaneousOperationResourceDetails({ endpoint }),
          );
          expect(info.result).toEqual({ limit: observed.customDocumentModels.limit });
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.DetectFacesFromUrl", () => {
      test(
        "detects the faces in a photo",
        Effect.gen(function* () {
          const endpoint = yield* faceEndpoint;
          const body = yield* call("/face/detect");
          expectOk(body);
          expect(body.result.rectangles.length).toBeGreaterThan(0);
          const observed = yield* asDeployer(
            face.FaceDetectionOperationsDetectFromUrl({
              endpoint,
              url: FACES_URL,
              detectionModel: "detection_03",
              recognitionModel: "recognition_04",
              returnFaceId: false,
            }),
          );
          expect(body.result.rectangles).toEqual(observed.map((f) => f.faceRectangle));
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.AnalyzeImageFromUrl", () => {
      test(
        "tags an image and reads its text",
        Effect.gen(function* () {
          const endpoint = yield* accountEndpoint;
          const body = yield* call("/image/analyze");
          expectOk(body);
          expect(body.result.lines.length).toBeGreaterThan(0);
          expect(body.result.tags).toContain("text");
          const observed = yield* asDeployer(
            vision.AnalyzeFromUrl({ endpoint, url: TEXT_URL, features: "read" }),
          );
          expect(body.result.lines).toEqual(
            (observed.readResult?.blocks ?? []).flatMap((b) => b.lines.map((l) => l.text)),
          );
        }),
        { timeout: 600_000 },
      );
    });

    describe("CognitiveServices.ListContentAnalyzers / UpdateContentAnalyzerDefaults / GetContentAnalyzerDefaults", () => {
      test(
        "lists the analyzers, then sets and reads the default model deployments",
        Effect.gen(function* () {
          const endpoint = yield* accountEndpoint;
          const listed = yield* call("/content/analyzers");
          expectOk(listed);
          expect(listed.result.ids).toContain("prebuilt-read");
          const observed = yield* asDeployer(cu.ListContentAnalyzers({ endpoint }));
          expect([...listed.result.ids].sort()).toEqual(
            observed.value.map((a) => a.analyzerId).sort(),
          );

          const updated = yield* call("/content/defaults/update");

          expectOk(updated);

          expect(updated.result.modelDeployments[MODEL]).toEqual(MODEL);

          const defaults = yield* call("/content/defaults");
          expectOk(defaults);

          expect(defaults.result.modelDeployments[MODEL]).toEqual(MODEL);
          const observedDefaults = yield* asDeployer(cu.GetContentAnalyzerDefaults({ endpoint }));
          expect(defaults.result).toEqual({ modelDeployments: observedDefaults.modelDeployments });
        }),
        { timeout: 600_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's data actions, scoped to the bound project or account",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const project = outputs.projectId.toLowerCase();
          const account = outputs.accountId.toLowerCase();
          const faceAccount = outputs.faceAccountId.toLowerCase();
          expect(grants).toEqual(
            [
              `AIServices/agents/read ${project}`,
              `AIServices/agents/write ${project}`,
              `AIServices/agents/delete ${project}`,
              `AIServices/deployments/read ${project}`,
              `AIServices/connections/read ${project}`,
              `FormRecognizer/documentmodels:analyze/action ${account}`,
              `FormRecognizer/documentmodels/analyzeresults/read ${account}`,
              `FormRecognizer/documentmodels/read ${account}`,
              `FormRecognizer/info/read ${account}`,
              `Face/detect/action ${faceAccount}`,
              `ComputerVision/imageanalysis:analyze/action ${account}`,
              `MultiModalIntelligence/analyzers/read ${account}`,
              `MultiModalIntelligence/defaults/read ${account}`,
              `MultiModalIntelligence/defaults/write ${account}`,
            ].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
