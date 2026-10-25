import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./ai-distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Model deployment the agents run on. */
export const MODEL = "gpt-4.1-mini";

/** Public sample image with faces and tags. */
export const FACES_URL =
  "https://raw.githubusercontent.com/Azure-Samples/cognitive-services-sample-data-files/master/ComputerVision/Images/faces.jpg";
/** Public sample image with printed text. */
export const TEXT_URL =
  "https://raw.githubusercontent.com/Azure-Samples/cognitive-services-sample-data-files/master/ComputerVision/Images/printed_text.jpg";

export const AiAccount = Azure.CognitiveServices.Account("AiBindingsAccount", {
  allowProjectManagement: true,
  identity: { type: "SystemAssigned" },
});

/** Face needs a `Face` account: an `AIServices` account does not serve Face v1.2. */
export const AiFaceAccount = Azure.CognitiveServices.Account("AiBindingsFaceAccount", {
  kind: "Face",
});

export const AiProject = Effect.gen(function* () {
  const account = yield* AiAccount;
  return yield* Azure.CognitiveServices.Project("AiBindingsProject", {
    account: account.accountName,
    displayName: "Alchemy AI bindings",
  });
});

export const AiModel = Effect.gen(function* () {
  const account = yield* AiAccount;
  return yield* Azure.CognitiveServices.Deployment("AiBindingsModel", {
    account: account.accountName,
    name: MODEL,
    model: { format: "OpenAI", name: MODEL, version: "2025-04-14" },
    sku: { name: "GlobalStandard", capacity: 1 },
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

/** `resultId` of a Document Intelligence `Operation-Location`. */
const resultIdOf = (location: string | undefined) =>
  location?.split("/analyzeResults/")[1]?.split("?")[0] ?? "";

/**
 * Effect-native Azure Function exercising the Azure AI data-plane
 * bindings on a managed-identity host, one route per behaviour. Routes
 * answer `{ ok, result | error }` with a 500 on error, so a caller retries
 * through the cold start and role propagation.
 */
export default class AiBindingsFunction extends Azure.Functions.Function<AiBindingsFunction>()(
  "AiBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see ai-distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* AiAccount;
    const faceAccount = yield* AiFaceAccount;
    const project = yield* AiProject;

    const createAgent = yield* Azure.CognitiveServices.CreateAgent(project);
    const getAgent = yield* Azure.CognitiveServices.GetAgent(project);
    const listAgents = yield* Azure.CognitiveServices.ListAgents(project);
    const updateAgent = yield* Azure.CognitiveServices.UpdateAgent(project);
    const deleteAgent = yield* Azure.CognitiveServices.DeleteAgent(project);
    const createThread = yield* Azure.CognitiveServices.CreateAgentThread(project);
    const deleteThread = yield* Azure.CognitiveServices.DeleteAgentThread(project);
    const createMessage = yield* Azure.CognitiveServices.CreateAgentMessage(project);
    const listMessages = yield* Azure.CognitiveServices.ListAgentMessages(project);
    const createRun = yield* Azure.CognitiveServices.CreateAgentRun(project);
    const getRun = yield* Azure.CognitiveServices.GetAgentRun(project);

    const listDeployments = yield* Azure.CognitiveServices.ListProjectDeployments(project);
    const getDeployment = yield* Azure.CognitiveServices.GetProjectDeployment(project);
    const listConnections = yield* Azure.CognitiveServices.ListProjectConnections(project);

    const analyzeDocument = yield* Azure.CognitiveServices.AnalyzeDocument(account);
    const getAnalyzeResult = yield* Azure.CognitiveServices.GetDocumentAnalyzeResult(account);
    const listModels = yield* Azure.CognitiveServices.ListDocumentModels(account);
    const getModel = yield* Azure.CognitiveServices.GetDocumentModel(account);
    const resourceDetails =
      yield* Azure.CognitiveServices.GetDocumentIntelligenceResourceDetails(account);

    const detectFaces = yield* Azure.CognitiveServices.DetectFacesFromUrl(faceAccount);
    const analyzeImage = yield* Azure.CognitiveServices.AnalyzeImageFromUrl(account);

    const listAnalyzers = yield* Azure.CognitiveServices.ListContentAnalyzers(account);
    const getDefaults = yield* Azure.CognitiveServices.GetContentAnalyzerDefaults(account);
    const updateDefaults = yield* Azure.CognitiveServices.UpdateContentAnalyzerDefaults(account);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const q = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          // ai-agents
          case "/agent/create":
            return yield* respond(
              Effect.map(
                createAgent({
                  model: MODEL,
                  name: q("name"),
                  instructions: "Reply with exactly one word: pong.",
                }),
                (agent) => ({ id: agent.id, name: agent.name, model: agent.model }),
              ),
            );
          case "/agent/get":
            return yield* respond(
              Effect.map(getAgent({ assistantId: q("id") }), (agent) => ({
                id: agent.id,
                name: agent.name,
              })),
            );
          case "/agent/list":
            return yield* respond(
              Effect.map(listAgents({ limit: 100 }), (page) => ({
                ids: page.data.map((agent) => agent.id),
              })),
            );
          case "/agent/update":
            return yield* respond(
              Effect.map(updateAgent({ assistantId: q("id"), name: q("name") }), (agent) => ({
                id: agent.id,
                name: agent.name,
              })),
            );
          case "/agent/delete":
            return yield* respond(
              Effect.map(deleteAgent({ assistantId: q("id") }), (status) => ({
                deleted: status.deleted,
              })),
            );
          case "/thread/create":
            return yield* respond(Effect.map(createThread(), (thread) => ({ id: thread.id })));
          case "/thread/delete":
            return yield* respond(
              Effect.map(deleteThread({ threadId: q("id") }), (status) => ({
                deleted: status.deleted,
              })),
            );
          case "/message/create":
            return yield* respond(
              Effect.map(
                createMessage({ threadId: q("thread"), role: "user", content: "ping" }),
                (message) => ({ id: message.id, role: message.role }),
              ),
            );
          case "/message/list":
            return yield* respond(
              Effect.map(listMessages({ threadId: q("thread"), order: "asc" }), (page) => ({
                messages: page.data.map((message) => ({
                  role: message.role,
                  text: message.content.map((item) => item.text?.value ?? "").join(""),
                })),
              })),
            );
          case "/run/create":
            return yield* respond(
              Effect.map(createRun({ threadId: q("thread"), assistant_id: q("agent") }), (run) => ({
                id: run.id,
                status: run.status,
              })),
            );
          case "/run/get":
            return yield* respond(
              Effect.map(getRun({ threadId: q("thread"), runId: q("run") }), (run) => ({
                status: run.status,
                error: run.last_error?.message,
              })),
            );

          // ai-projects
          case "/project/deployments":
            return yield* respond(
              Effect.map(listDeployments(), (page) => ({
                names: page.value.map((deployment) => deployment.name),
              })),
            );
          case "/project/deployment":
            return yield* respond(
              Effect.map(getDeployment({ name: MODEL }), (deployment) => ({
                name: deployment.name,
                type: deployment.type,
              })),
            );
          case "/project/connections":
            return yield* respond(
              Effect.map(listConnections(), (page) => ({
                names: page.value.map((connection) => connection.name),
              })),
            );

          // ai-document-intelligence
          case "/document/analyze":
            return yield* respond(
              Effect.map(
                analyzeDocument({ modelId: "prebuilt-read", urlSource: TEXT_URL }),
                (accepted) => ({ resultId: resultIdOf(accepted.operationLocation) }),
              ),
            );
          case "/document/result":
            return yield* respond(
              Effect.map(
                getAnalyzeResult({ modelId: "prebuilt-read", resultId: q("id") }),
                (operation) => ({
                  status: operation.status,
                  content: operation.analyzeResult?.content ?? "",
                }),
              ),
            );
          case "/document/models":
            return yield* respond(
              Effect.map(listModels(), (page) => ({
                ids: page.value.map((model) => model.modelId),
              })),
            );
          case "/document/model":
            return yield* respond(
              Effect.map(getModel({ modelId: "prebuilt-read" }), (model) => ({
                modelId: model.modelId,
              })),
            );
          case "/document/info":
            return yield* respond(
              Effect.map(resourceDetails(), (details) => ({
                limit: details.customDocumentModels.limit,
              })),
            );

          // ai-face
          case "/face/detect":
            return yield* respond(
              Effect.map(
                detectFaces({
                  url: FACES_URL,
                  detectionModel: "detection_03",
                  recognitionModel: "recognition_04",
                  returnFaceId: false,
                }),
                (faces) => ({ rectangles: faces.map((face) => face.faceRectangle) }),
              ),
            );

          // ai-image-analysis
          case "/image/analyze":
            return yield* respond(
              Effect.map(analyzeImage({ url: TEXT_URL, features: "tags,read" }), (result) => ({
                tags: (result.tagsResult?.values ?? []).map((tag) => tag.name),
                lines: (result.readResult?.blocks ?? []).flatMap((block) =>
                  block.lines.map((line) => line.text),
                ),
              })),
            );

          // ai-content-understanding
          case "/content/analyzers":
            return yield* respond(
              Effect.map(listAnalyzers(), (page) => ({
                ids: page.value.map((analyzer) => analyzer.analyzerId),
              })),
            );
          case "/content/defaults/update":
            return yield* respond(
              Effect.map(updateDefaults({ modelDeployments: { [MODEL]: MODEL } }), (defaults) => ({
                modelDeployments: defaults.modelDeployments,
              })),
            );
          case "/content/defaults":
            return yield* respond(
              Effect.map(getDefaults(), (defaults) => ({
                modelDeployments: defaults.modelDeployments,
              })),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.CognitiveServices.CreateAgentHttp,
        Azure.CognitiveServices.GetAgentHttp,
        Azure.CognitiveServices.ListAgentsHttp,
        Azure.CognitiveServices.UpdateAgentHttp,
        Azure.CognitiveServices.DeleteAgentHttp,
        Azure.CognitiveServices.CreateAgentThreadHttp,
        Azure.CognitiveServices.DeleteAgentThreadHttp,
        Azure.CognitiveServices.CreateAgentMessageHttp,
        Azure.CognitiveServices.ListAgentMessagesHttp,
        Azure.CognitiveServices.CreateAgentRunHttp,
        Azure.CognitiveServices.GetAgentRunHttp,
        Azure.CognitiveServices.ListProjectDeploymentsHttp,
        Azure.CognitiveServices.GetProjectDeploymentHttp,
        Azure.CognitiveServices.ListProjectConnectionsHttp,
        Azure.CognitiveServices.AnalyzeDocumentHttp,
        Azure.CognitiveServices.GetDocumentAnalyzeResultHttp,
        Azure.CognitiveServices.ListDocumentModelsHttp,
        Azure.CognitiveServices.GetDocumentModelHttp,
        Azure.CognitiveServices.GetDocumentIntelligenceResourceDetailsHttp,
        Azure.CognitiveServices.DetectFacesFromUrlHttp,
        Azure.CognitiveServices.AnalyzeImageFromUrlHttp,
        Azure.CognitiveServices.ListContentAnalyzersHttp,
        Azure.CognitiveServices.GetContentAnalyzerDefaultsHttp,
        Azure.CognitiveServices.UpdateContentAnalyzerDefaultsHttp,
      ),
    ),
  ),
) {}
