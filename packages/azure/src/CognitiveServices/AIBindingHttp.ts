import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";
import type { Project } from "./Project.ts";

/**
 * Shared scaffolding for the Azure AI data-plane bindings (`ai-agents`,
 * `ai-projects`, `ai-content-understanding`, `ai-document-intelligence`,
 * `ai-face`, `ai-health-insights`, `ai-image-analysis`): resolves the
 * distilled operation once when the layer is built, injects the bound
 * project's or account's `endpoint`, and assigns the binding's custom role
 * on that project or account at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const ACCOUNTS = "Microsoft.CognitiveServices/accounts";

/**
 * Data actions the Azure AI data planes check for Microsoft Entra callers
 * (Azure RBAC, `Microsoft.CognitiveServices` provider operations; Content
 * Understanding's are under `MultiModalIntelligence`).
 */
export const AIDataAction = {
  agentsRead: `${ACCOUNTS}/AIServices/agents/read`,
  agentsWrite: `${ACCOUNTS}/AIServices/agents/write`,
  agentsDelete: `${ACCOUNTS}/AIServices/agents/delete`,
  connectionsRead: `${ACCOUNTS}/AIServices/connections/read`,
  connectionsListSecrets: `${ACCOUNTS}/AIServices/connections/listSecrets/action`,
  deploymentsRead: `${ACCOUNTS}/AIServices/deployments/read`,
  assetsRead: `${ACCOUNTS}/AIServices/assets/read`,
  assetsWrite: `${ACCOUNTS}/AIServices/assets/write`,
  assetsDelete: `${ACCOUNTS}/AIServices/assets/delete`,

  analyzersAnalyze: `${ACCOUNTS}/MultiModalIntelligence/analyzers:analyze/action`,
  analyzersAnalyzeBinary: `${ACCOUNTS}/MultiModalIntelligence/analyzers:analyzebinary/action`,
  analyzersCopy: `${ACCOUNTS}/MultiModalIntelligence/analyzers:copy/action`,
  analyzersGrantCopy: `${ACCOUNTS}/MultiModalIntelligence/analyzers:grantCopyAuthorization/action`,
  analyzersRead: `${ACCOUNTS}/MultiModalIntelligence/analyzers/read`,
  analyzersWrite: `${ACCOUNTS}/MultiModalIntelligence/analyzers/write`,
  analyzersDelete: `${ACCOUNTS}/MultiModalIntelligence/analyzers/delete`,
  analyzerOperationsRead: `${ACCOUNTS}/MultiModalIntelligence/analyzers/operations/read`,
  analyzerResultsRead: `${ACCOUNTS}/MultiModalIntelligence/analyzerresults/read`,
  analyzerResultFilesRead: `${ACCOUNTS}/MultiModalIntelligence/analyzerresults/files/read`,
  analyzerResultsDelete: `${ACCOUNTS}/MultiModalIntelligence/analyzerresults/delete`,
  analyzerDefaultsRead: `${ACCOUNTS}/MultiModalIntelligence/defaults/read`,
  analyzerDefaultsWrite: `${ACCOUNTS}/MultiModalIntelligence/defaults/write`,

  documentAnalyze: `${ACCOUNTS}/FormRecognizer/documentmodels:analyze/action`,
  documentAnalyzeBatch: `${ACCOUNTS}/FormRecognizer/documentmodels:analyzebatch/action`,
  documentAnalyzeResults: `${ACCOUNTS}/FormRecognizer/documentmodels/analyzeresults/*`,
  documentAnalyzeResultsRead: `${ACCOUNTS}/FormRecognizer/documentmodels/analyzeresults/read`,
  documentAnalyzeResultFiguresRead: `${ACCOUNTS}/FormRecognizer/documentmodels/analyzeresults/figures/read`,
  documentAnalyzeResultPdfRead: `${ACCOUNTS}/FormRecognizer/documentmodels/analyzeresults/pdf/read`,
  documentAnalyzeBatchResults: `${ACCOUNTS}/FormRecognizer/documentmodels/analyzebatchresults/*`,
  documentAnalyzeBatchResultsRead: `${ACCOUNTS}/FormRecognizer/documentmodels/analyzebatchresults/read`,
  documentModelsRead: `${ACCOUNTS}/FormRecognizer/documentmodels/read`,
  documentModelsDelete: `${ACCOUNTS}/FormRecognizer/documentmodels/delete`,
  documentModelsBuild: `${ACCOUNTS}/FormRecognizer/documentmodels:build/action`,
  documentModelsBuildWrite: `${ACCOUNTS}/FormRecognizer/documentmodels:build/write`,
  documentModelsCompose: `${ACCOUNTS}/FormRecognizer/documentmodels:compose/action`,
  documentModelsComposeWrite: `${ACCOUNTS}/FormRecognizer/documentmodels:compose/write`,
  documentModelsAuthorizeCopy: `${ACCOUNTS}/FormRecognizer/documentmodels:authorizecopy/action`,
  documentModelsCopyTo: `${ACCOUNTS}/FormRecognizer/documentmodels:copyto/action`,
  documentClassify: `${ACCOUNTS}/FormRecognizer/documentclassifiers:analyze/action`,
  documentClassifyResultsRead: `${ACCOUNTS}/FormRecognizer/documentclassifiers/analyzeresults/read`,
  documentClassifiersRead: `${ACCOUNTS}/FormRecognizer/documentclassifiers/read`,
  documentClassifiersDelete: `${ACCOUNTS}/FormRecognizer/documentclassifiers/delete`,
  documentClassifiersBuild: `${ACCOUNTS}/FormRecognizer/documentclassifiers:build/write`,
  documentClassifiersAuthorizeCopy: `${ACCOUNTS}/FormRecognizer/documentclassifiers:authorizecopy/action`,
  documentClassifiersCopyTo: `${ACCOUNTS}/FormRecognizer/documentclassifiers:copyto/action`,
  documentOperationsRead: `${ACCOUNTS}/FormRecognizer/operations/read`,
  documentInfoRead: `${ACCOUNTS}/FormRecognizer/info/read`,

  faceDetect: `${ACCOUNTS}/Face/detect/action`,
  faceFindSimilar: `${ACCOUNTS}/Face/findsimilars/action`,
  faceGroup: `${ACCOUNTS}/Face/group/action`,
  faceIdentify: `${ACCOUNTS}/Face/identify/action`,
  faceVerify: `${ACCOUNTS}/Face/verify/action`,
  faceListsRead: `${ACCOUNTS}/Face/facelists/read`,
  faceListsWrite: `${ACCOUNTS}/Face/facelists/write`,
  faceListsDelete: `${ACCOUNTS}/Face/facelists/delete`,
  faceListFacesWrite: `${ACCOUNTS}/Face/facelists/persistedfaces/write`,
  faceListFacesDelete: `${ACCOUNTS}/Face/facelists/persistedfaces/delete`,
  largeFaceListsRead: `${ACCOUNTS}/Face/largefacelists/read`,
  largeFaceListsWrite: `${ACCOUNTS}/Face/largefacelists/write`,
  largeFaceListsDelete: `${ACCOUNTS}/Face/largefacelists/delete`,
  largeFaceListFacesRead: `${ACCOUNTS}/Face/largefacelists/persistedfaces/read`,
  largeFaceListFacesWrite: `${ACCOUNTS}/Face/largefacelists/persistedfaces/write`,
  largeFaceListFacesDelete: `${ACCOUNTS}/Face/largefacelists/persistedfaces/delete`,
  largeFaceListsTrain: `${ACCOUNTS}/Face/largefacelists/train/action`,
  largeFaceListsTrainingRead: `${ACCOUNTS}/Face/largefacelists/training/read`,
  personGroupsRead: `${ACCOUNTS}/Face/persongroups/read`,
  personGroupsWrite: `${ACCOUNTS}/Face/persongroups/write`,
  personGroupsDelete: `${ACCOUNTS}/Face/persongroups/delete`,
  personGroupPersonsCreate: `${ACCOUNTS}/Face/persongroups/persons/action`,
  personGroupPersonsRead: `${ACCOUNTS}/Face/persongroups/persons/read`,
  personGroupPersonsWrite: `${ACCOUNTS}/Face/persongroups/persons/write`,
  personGroupPersonsDelete: `${ACCOUNTS}/Face/persongroups/persons/delete`,
  personGroupFacesRead: `${ACCOUNTS}/Face/persongroups/persons/persistedfaces/read`,
  personGroupFacesWrite: `${ACCOUNTS}/Face/persongroups/persons/persistedfaces/write`,
  personGroupFacesDelete: `${ACCOUNTS}/Face/persongroups/persons/persistedfaces/delete`,
  personGroupsTrain: `${ACCOUNTS}/Face/persongroups/train/action`,
  personGroupsTrainingRead: `${ACCOUNTS}/Face/persongroups/training/read`,
  largePersonGroupsRead: `${ACCOUNTS}/Face/largepersongroups/read`,
  largePersonGroupsWrite: `${ACCOUNTS}/Face/largepersongroups/write`,
  largePersonGroupsDelete: `${ACCOUNTS}/Face/largepersongroups/delete`,
  largePersonGroupPersonsCreate: `${ACCOUNTS}/Face/largepersongroups/persons/action`,
  largePersonGroupPersonsRead: `${ACCOUNTS}/Face/largepersongroups/persons/read`,
  largePersonGroupPersonsWrite: `${ACCOUNTS}/Face/largepersongroups/persons/write`,
  largePersonGroupPersonsDelete: `${ACCOUNTS}/Face/largepersongroups/persons/delete`,
  largePersonGroupFacesRead: `${ACCOUNTS}/Face/largepersongroups/persons/persistedfaces/read`,
  largePersonGroupFacesWrite: `${ACCOUNTS}/Face/largepersongroups/persons/persistedfaces/write`,
  largePersonGroupFacesDelete: `${ACCOUNTS}/Face/largepersongroups/persons/persistedfaces/delete`,
  largePersonGroupsTrain: `${ACCOUNTS}/Face/largepersongroups/train/action`,
  largePersonGroupsTrainingRead: `${ACCOUNTS}/Face/largepersongroups/training/read`,
  livenessSessionsCreate: `${ACCOUNTS}/Face/detectliveness/singlemodal/sessions/action`,
  livenessSessionsRead: `${ACCOUNTS}/Face/detectliveness/singlemodal/sessions/read`,
  livenessSessionsDelete: `${ACCOUNTS}/Face/detectliveness/singlemodal/sessions/delete`,
  livenessVerifySessionsCreate: `${ACCOUNTS}/Face/detectlivenesswithverify/singlemodal/sessions/action`,
  livenessVerifySessionsRead: `${ACCOUNTS}/Face/detectlivenesswithverify/singlemodal/sessions/read`,
  livenessVerifySessionsDelete: `${ACCOUNTS}/Face/detectlivenesswithverify/singlemodal/sessions/delete`,
  sessionImagesRead: `${ACCOUNTS}/Face/session/sessionimages/read`,

  radiologyInsightsJobsWrite: `${ACCOUNTS}/HealthInsights/radiology-insights/jobs/write`,
  radiologyInsightsJobsRead: `${ACCOUNTS}/HealthInsights/radiology-insights/jobs/read`,

  imageAnalysisAnalyze: `${ACCOUNTS}/ComputerVision/imageanalysis:analyze/action`,
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound project or
 * account) with exactly `dataActions`. Bindings with the same data actions
 * share one role, so a host that binds several gets one assignment. The
 * smallest built-in roles (**Azure AI User**, **Cognitive Services User**)
 * grant every `Microsoft.CognitiveServices/*` data action, so every binding
 * uses a custom role.
 */
export interface AIGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const D = AIDataAction;
const grant = (role: string, ...dataActions: string[]): AIGrant => ({ role, dataActions });

/** Custom role per binding kind; the logical ID is `AzureAI<role>Role`. */
export const AIRole = {
  AgentsRead: grant("AgentsRead", D.agentsRead),
  AgentsWrite: grant("AgentsWrite", D.agentsWrite),
  AgentsDelete: grant("AgentsDelete", D.agentsDelete),
  ProjectConnectionsRead: grant("ProjectConnectionsRead", D.connectionsRead),
  ProjectConnectionSecrets: grant("ProjectConnectionSecrets", D.connectionsListSecrets),
  ProjectDeploymentsRead: grant("ProjectDeploymentsRead", D.deploymentsRead),
  ProjectAssetsRead: grant("ProjectAssetsRead", D.assetsRead),
  ProjectAssetsWrite: grant("ProjectAssetsWrite", D.assetsWrite),
  ProjectAssetsDelete: grant("ProjectAssetsDelete", D.assetsDelete),

  ContentAnalyze: grant("ContentAnalyze", D.analyzersAnalyze),
  ContentAnalyzeBinary: grant("ContentAnalyzeBinary", D.analyzersAnalyzeBinary),
  ContentAnalyzerCopy: grant("ContentAnalyzerCopy", D.analyzersCopy),
  ContentAnalyzerGrantCopy: grant("ContentAnalyzerGrantCopy", D.analyzersGrantCopy),
  ContentAnalyzersRead: grant("ContentAnalyzersRead", D.analyzersRead),
  ContentAnalyzersWrite: grant("ContentAnalyzersWrite", D.analyzersWrite),
  ContentAnalyzersDelete: grant("ContentAnalyzersDelete", D.analyzersDelete),
  ContentAnalyzerOperationsRead: grant("ContentAnalyzerOperationsRead", D.analyzerOperationsRead),
  ContentResultsRead: grant("ContentResultsRead", D.analyzerResultsRead),
  ContentResultFilesRead: grant("ContentResultFilesRead", D.analyzerResultFilesRead),
  ContentResultsDelete: grant("ContentResultsDelete", D.analyzerResultsDelete),
  ContentDefaultsRead: grant("ContentDefaultsRead", D.analyzerDefaultsRead),
  ContentDefaultsWrite: grant("ContentDefaultsWrite", D.analyzerDefaultsWrite),

  DocumentAnalyze: grant("DocumentAnalyze", D.documentAnalyze),
  DocumentAnalyzeBatch: grant("DocumentAnalyzeBatch", D.documentAnalyzeBatch),
  DocumentAnalyzeResultsRead: grant("DocumentAnalyzeResultsRead", D.documentAnalyzeResultsRead),
  // The provider lists no `analyzeresults/delete` data action; the wildcard
  // covers the result only (read, figures, pdf, delete).
  DocumentAnalyzeResults: grant("DocumentAnalyzeResults", D.documentAnalyzeResults),
  DocumentAnalyzeResultFiguresRead: grant(
    "DocumentAnalyzeResultFiguresRead",
    D.documentAnalyzeResultFiguresRead,
  ),
  DocumentAnalyzeResultPdfRead: grant(
    "DocumentAnalyzeResultPdfRead",
    D.documentAnalyzeResultPdfRead,
  ),
  DocumentAnalyzeBatchResultsRead: grant(
    "DocumentAnalyzeBatchResultsRead",
    D.documentAnalyzeBatchResultsRead,
  ),
  DocumentAnalyzeBatchResults: grant("DocumentAnalyzeBatchResults", D.documentAnalyzeBatchResults),
  DocumentModelsRead: grant("DocumentModelsRead", D.documentModelsRead),
  DocumentModelsDelete: grant("DocumentModelsDelete", D.documentModelsDelete),
  DocumentModelsBuild: grant(
    "DocumentModelsBuild",
    D.documentModelsBuild,
    D.documentModelsBuildWrite,
  ),
  DocumentModelsCompose: grant(
    "DocumentModelsCompose",
    D.documentModelsCompose,
    D.documentModelsComposeWrite,
  ),
  DocumentModelsAuthorizeCopy: grant("DocumentModelsAuthorizeCopy", D.documentModelsAuthorizeCopy),
  DocumentModelsCopyTo: grant("DocumentModelsCopyTo", D.documentModelsCopyTo),
  DocumentClassify: grant("DocumentClassify", D.documentClassify),
  DocumentClassifyResultsRead: grant("DocumentClassifyResultsRead", D.documentClassifyResultsRead),
  DocumentClassifiersRead: grant("DocumentClassifiersRead", D.documentClassifiersRead),
  DocumentClassifiersDelete: grant("DocumentClassifiersDelete", D.documentClassifiersDelete),
  DocumentClassifiersBuild: grant("DocumentClassifiersBuild", D.documentClassifiersBuild),
  DocumentClassifiersAuthorizeCopy: grant(
    "DocumentClassifiersAuthorizeCopy",
    D.documentClassifiersAuthorizeCopy,
  ),
  DocumentClassifiersCopyTo: grant("DocumentClassifiersCopyTo", D.documentClassifiersCopyTo),
  DocumentOperationsRead: grant("DocumentOperationsRead", D.documentOperationsRead),
  DocumentInfoRead: grant("DocumentInfoRead", D.documentInfoRead),

  FaceDetect: grant("FaceDetect", D.faceDetect),
  FaceFindSimilar: grant("FaceFindSimilar", D.faceFindSimilar),
  FaceGroup: grant("FaceGroup", D.faceGroup),
  FaceIdentify: grant("FaceIdentify", D.faceIdentify),
  FaceVerify: grant("FaceVerify", D.faceVerify),
  FaceListsRead: grant("FaceListsRead", D.faceListsRead),
  FaceListsWrite: grant("FaceListsWrite", D.faceListsWrite),
  FaceListsDelete: grant("FaceListsDelete", D.faceListsDelete),
  FaceListFacesWrite: grant("FaceListFacesWrite", D.faceListFacesWrite),
  FaceListFacesDelete: grant("FaceListFacesDelete", D.faceListFacesDelete),
  LargeFaceListsRead: grant("LargeFaceListsRead", D.largeFaceListsRead),
  LargeFaceListsWrite: grant("LargeFaceListsWrite", D.largeFaceListsWrite),
  LargeFaceListsDelete: grant("LargeFaceListsDelete", D.largeFaceListsDelete),
  LargeFaceListFacesRead: grant("LargeFaceListFacesRead", D.largeFaceListFacesRead),
  LargeFaceListFacesWrite: grant("LargeFaceListFacesWrite", D.largeFaceListFacesWrite),
  LargeFaceListFacesDelete: grant("LargeFaceListFacesDelete", D.largeFaceListFacesDelete),
  LargeFaceListsTrain: grant("LargeFaceListsTrain", D.largeFaceListsTrain),
  LargeFaceListsTrainingRead: grant("LargeFaceListsTrainingRead", D.largeFaceListsTrainingRead),
  PersonGroupsRead: grant("PersonGroupsRead", D.personGroupsRead),
  PersonGroupsWrite: grant("PersonGroupsWrite", D.personGroupsWrite),
  PersonGroupsDelete: grant("PersonGroupsDelete", D.personGroupsDelete),
  PersonGroupPersonsCreate: grant("PersonGroupPersonsCreate", D.personGroupPersonsCreate),
  PersonGroupPersonsRead: grant("PersonGroupPersonsRead", D.personGroupPersonsRead),
  PersonGroupPersonsWrite: grant("PersonGroupPersonsWrite", D.personGroupPersonsWrite),
  PersonGroupPersonsDelete: grant("PersonGroupPersonsDelete", D.personGroupPersonsDelete),
  PersonGroupFacesRead: grant("PersonGroupFacesRead", D.personGroupFacesRead),
  PersonGroupFacesWrite: grant("PersonGroupFacesWrite", D.personGroupFacesWrite),
  PersonGroupFacesDelete: grant("PersonGroupFacesDelete", D.personGroupFacesDelete),
  PersonGroupsTrain: grant("PersonGroupsTrain", D.personGroupsTrain),
  PersonGroupsTrainingRead: grant("PersonGroupsTrainingRead", D.personGroupsTrainingRead),
  LargePersonGroupsRead: grant("LargePersonGroupsRead", D.largePersonGroupsRead),
  LargePersonGroupsWrite: grant("LargePersonGroupsWrite", D.largePersonGroupsWrite),
  LargePersonGroupsDelete: grant("LargePersonGroupsDelete", D.largePersonGroupsDelete),
  LargePersonGroupPersonsCreate: grant(
    "LargePersonGroupPersonsCreate",
    D.largePersonGroupPersonsCreate,
  ),
  LargePersonGroupPersonsRead: grant("LargePersonGroupPersonsRead", D.largePersonGroupPersonsRead),
  LargePersonGroupPersonsWrite: grant(
    "LargePersonGroupPersonsWrite",
    D.largePersonGroupPersonsWrite,
  ),
  LargePersonGroupPersonsDelete: grant(
    "LargePersonGroupPersonsDelete",
    D.largePersonGroupPersonsDelete,
  ),
  LargePersonGroupFacesRead: grant("LargePersonGroupFacesRead", D.largePersonGroupFacesRead),
  LargePersonGroupFacesWrite: grant("LargePersonGroupFacesWrite", D.largePersonGroupFacesWrite),
  LargePersonGroupFacesDelete: grant("LargePersonGroupFacesDelete", D.largePersonGroupFacesDelete),
  LargePersonGroupsTrain: grant("LargePersonGroupsTrain", D.largePersonGroupsTrain),
  LargePersonGroupsTrainingRead: grant(
    "LargePersonGroupsTrainingRead",
    D.largePersonGroupsTrainingRead,
  ),
  LivenessSessionsCreate: grant("LivenessSessionsCreate", D.livenessSessionsCreate),
  LivenessSessionsRead: grant("LivenessSessionsRead", D.livenessSessionsRead),
  LivenessSessionsDelete: grant("LivenessSessionsDelete", D.livenessSessionsDelete),
  LivenessVerifySessionsCreate: grant(
    "LivenessVerifySessionsCreate",
    D.livenessVerifySessionsCreate,
  ),
  LivenessVerifySessionsRead: grant("LivenessVerifySessionsRead", D.livenessVerifySessionsRead),
  LivenessVerifySessionsDelete: grant(
    "LivenessVerifySessionsDelete",
    D.livenessVerifySessionsDelete,
  ),
  SessionImagesRead: grant("SessionImagesRead", D.sessionImagesRead),

  RadiologyInsightsJobsWrite: grant("RadiologyInsightsJobsWrite", D.radiologyInsightsJobsWrite),
  RadiologyInsightsJobsRead: grant("RadiologyInsightsJobsRead", D.radiologyInsightsJobsRead),

  ImageAnalysis: grant("ImageAnalysis", D.imageAnalysisAnalyze),
} as const satisfies Record<string, AIGrant>;

/** Assign `grant` on `scope` to the host, creating its custom role. */
const GrantAIRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: Account | Project,
    scope: Output.Output<string, never>,
    grant: AIGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureAI${grant.role}Role`, {
        description: `Alchemy Azure AI binding: ${grant.dataActions.join(", ")}`,
        permissions: [{ dataActions: [...grant.dataActions] }],
      });
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: role.roleDefinitionId, scope },
      ];
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/** Name of the project endpoint in `Project.endpoints`. */
const FOUNDRY_API = "AI Foundry API";

/**
 * `https://{subdomain}.services.ai.azure.com/api/projects/{name}`, resolved
 * per call at runtime.
 */
const projectEndpointOf = (project: Project) =>
  project.endpoints.pipe(Output.map((endpoints) => endpoints[FOUNDRY_API] ?? ""));

/** `https://{subdomain}.cognitiveservices.azure.com/`, resolved per call at runtime. */
const accountEndpointOf = (account: Account) =>
  account.endpoint.pipe(Output.map((endpoint) => endpoint ?? ""));

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build the impl Effect for an operation of a Foundry project's data plane
 * (`ai-agents`, `ai-projects`): the runtime callable injects the bound
 * {@link Project}'s endpoint, and the deploy-time half assigns `grant` on
 * the project.
 */
export const makeProjectHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CognitiveServices.CreateAgent`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Role assigned on the project. */
  grant: AIGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantAIRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (project: Project) {
      yield* grant(options.tag, project, project.projectId, options.grant);
      const endpoint = yield* projectEndpointOf(project);
      return Effect.fn(`${options.tag}(${project.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* endpoint;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation of an Azure AI services account's
 * data plane (Content Understanding, Document Intelligence, Face, Health
 * Insights, Image Analysis): the runtime callable injects the bound
 * {@link Account}'s endpoint, and the deploy-time half assigns `grant` on
 * the account.
 */
export const makeAccountHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.CognitiveServices.AnalyzeDocument`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Role assigned on the account. */
  grant: AIGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantAIRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account) {
      yield* grant(options.tag, account, account.accountId, options.grant);
      const endpoint = yield* accountEndpointOf(account);
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* endpoint;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });
