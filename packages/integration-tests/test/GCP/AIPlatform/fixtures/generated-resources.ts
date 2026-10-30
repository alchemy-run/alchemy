import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";
import { UsersSource } from "./features.ts";

/**
 * Vertex AI resources the generated bindings bind: the suite's own agent,
 * pipeline and sandboxes, plus the free metadata-only resources.
 */
export { Agent, Browser, Code, Train } from "./bindings-host.ts";

const location = "us-central1";

export const ProbeDataset = GCP.AIPlatform.Dataset("ProbeDataset", {
  location,
  displayName: "alchemy-probe",
  metadata: {},
});
export const ProbeEndpoint = GCP.AIPlatform.Endpoint("ProbeEndpoint", {
  location,
  displayName: "alchemy-probe",
});
export const ProbeIndexEndpoint = GCP.AIPlatform.IndexEndpoint("ProbeIndexEndpoint", {
  location,
  displayName: "alchemy-probe",
  publicEndpointEnabled: true,
});
export const ProbeMetadataStore = GCP.AIPlatform.MetadataStore("ProbeMetadataStore", {
  location,
});
export const ProbeArtifact = Effect.gen(function* () {
  const store = yield* ProbeMetadataStore;
  return yield* GCP.AIPlatform.MetadataStoresArtifact("ProbeArtifact", {
    metadataStore: store.name,
    displayName: "probe-artifact",
    state: "LIVE",
  });
});
export const ProbeContext = Effect.gen(function* () {
  const store = yield* ProbeMetadataStore;
  return yield* GCP.AIPlatform.MetadataStoresContext("ProbeContext", {
    metadataStore: store.name,
    displayName: "probe-context",
  });
});
export const ProbeExecution = Effect.gen(function* () {
  const store = yield* ProbeMetadataStore;
  return yield* GCP.AIPlatform.MetadataStoresExecution("ProbeExecution", {
    metadataStore: store.name,
    displayName: "probe-execution",
    state: "RUNNING",
  });
});
export const ProbeTensorboard = GCP.AIPlatform.Tensorboard("ProbeTensorboard", {
  location,
  displayName: "alchemy-probe",
});
export const ProbeExperiment = Effect.gen(function* () {
  const board = yield* ProbeTensorboard;
  return yield* GCP.AIPlatform.TensorboardsExperiment("ProbeExperiment", {
    parent: board.name,
    displayName: "probe",
  });
});
export const ProbeRun = Effect.gen(function* () {
  const experiment = yield* ProbeExperiment;
  return yield* GCP.AIPlatform.TensorboardsExperimentsRun("ProbeRun", {
    parent: experiment.name,
    displayName: "probe-run",
  });
});
export const ProbeStudy = GCP.AIPlatform.Study("ProbeStudy", {
  location,
  displayName: "alchemy_probe_study",
  studySpec: {
    metrics: [{ metricId: "accuracy", goal: "MAXIMIZE" }],
    parameters: [{ parameterId: "lr", doubleValueSpec: { minValue: 0.001, maxValue: 0.1 } }],
    algorithm: "RANDOM_SEARCH",
  },
});
export const ProbeNotebookTemplate = GCP.AIPlatform.NotebookRuntimeTemplate(
  "ProbeNotebookTemplate",
  {
    location,
    displayName: "alchemy-probe",
    machineSpec: { machineType: "e2-standard-4" },
    networkSpec: { enableInternetAccess: true },
  },
);
export const ProbeEvaluationItem = GCP.AIPlatform.EvaluationItem("ProbeEvaluationItem", {
  location,
  displayName: "alchemy-probe",
  evaluationItemType: "REQUEST",
  evaluationRequest: { prompt: { text: "What is 2+2?" } },
});
export const ProbeEvaluationSet = Effect.gen(function* () {
  const item = yield* ProbeEvaluationItem;
  return yield* GCP.AIPlatform.EvaluationSet("ProbeEvaluationSet", {
    location,
    displayName: "alchemy-probe",
    evaluationItems: [item.name],
  });
});
export const ProbeSession = Effect.gen(function* () {
  const engine = yield* GCP.AIPlatform.ReasoningEngine("ProbeSessionEngine", {
    location,
    displayName: "alchemy-probe-sessions",
    spec: { agentFramework: "custom" },
  });
  return yield* GCP.AIPlatform.ReasoningEnginesSession("ProbeSession", {
    parent: engine.name,
    userId: "alchemy-probe",
  });
});

export const ProbeCustomJob = GCP.AIPlatform.CustomJob("ProbeCustomJob", {
  location: "us-central1",
  displayName: "alchemy-echo",
  jobSpec: {
    workerPoolSpecs: [
      {
        machineSpec: { machineType: "n1-standard-4" },
        replicaCount: "1",
        containerSpec: {
          imageUri: "gcr.io/google-samples/hello-app:1.0",
          command: ["echo"],
          args: ["ok"],
        },
      },
    ],
    scheduling: { timeout: "600s" },
  },
});
export const ProbeDeploymentResourcePool = GCP.AIPlatform.DeploymentResourcePool(
  "ProbeDeploymentResourcePool",
  {
    location: "us-central1",
    dedicatedResources: {
      minReplicaCount: 1,
      maxReplicaCount: 1,
      machineSpec: { machineType: "n1-standard-2" },
    },
  },
);
export const ProbeFeatureOnlineStore = GCP.AIPlatform.FeatureOnlineStore(
  "ProbeFeatureOnlineStore",
  {
    location: "us-central1",
  },
);

export const ProbeFeaturestore = GCP.AIPlatform.Featurestore("ProbeFeaturestore", { location });
export const ProbeEntityType = Effect.gen(function* () {
  const store = yield* ProbeFeaturestore;
  return yield* GCP.AIPlatform.FeaturestoresEntityType("ProbeEntityType", {
    featurestore: store.name,
    location,
  });
});
export const ProbeEntityFeature = Effect.gen(function* () {
  const entity = yield* ProbeEntityType;
  return yield* GCP.AIPlatform.FeaturestoresEntityTypesFeature("ProbeEntityFeature", {
    entityType: entity.name,
    valueType: "INT64",
  });
});
export const ProbeTrial = Effect.gen(function* () {
  const study = yield* ProbeStudy;
  return yield* GCP.AIPlatform.StudiesTrial("ProbeTrial", {
    parent: study.name,
    parameters: [{ parameterId: "lr", value: 0.01 }],
  });
});
export const ProbeTimeSeries = Effect.gen(function* () {
  const run = yield* ProbeRun;
  return yield* GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeries("ProbeTimeSeries", {
    parent: run.name,
    displayName: "loss",
    valueType: "SCALAR",
    pluginName: "scalars",
  });
});
export const ProbeMemory = Effect.gen(function* () {
  const engine = yield* GCP.AIPlatform.ReasoningEngine("ProbeMemoryEngine", {
    location,
    displayName: "alchemy-probe-memory",
    spec: { agentFramework: "custom" },
  });
  return yield* GCP.AIPlatform.ReasoningEnginesMemory("ProbeMemory", {
    reasoningEngine: engine.name,
    location,
    scope: { user_id: "alchemy-probe" },
    fact: "the user prefers concise answers",
  });
});

export const ProbeIndex = GCP.AIPlatform.Index("ProbeIndex", {
  location,
  displayName: "alchemy-probe-index",
  indexUpdateMethod: "STREAM_UPDATE",
  metadata: {
    config: {
      dimensions: 8,
      approximateNeighborsCount: 10,
      distanceMeasureType: "DOT_PRODUCT_DISTANCE",
      shardSize: "SHARD_SIZE_SMALL",
      algorithmConfig: { bruteForceConfig: {} },
    },
  },
});
export const ProbeCachedContent = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.AIPlatform.CachedContent("ProbeCachedContent", {
    location,
    model: `projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash`,
    ttl: "3600s",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: Array.from(
              { length: 400 },
              (_, i) => `Rule ${i + 1}: answer question ${i + 1} in at most ${i + 2} words.`,
            ).join("\n"),
          },
        ],
      },
    ],
  });
});
export const ProbeFeatureGroup = Effect.gen(function* () {
  const inputUri = yield* UsersSource;
  return yield* GCP.AIPlatform.FeatureGroup("ProbeFeatureGroup", {
    location,
    bigQuery: { inputUri, entityIdColumns: ["entity_id"] },
  });
});
export const ProbeGroupFeature = Effect.gen(function* () {
  const group = yield* ProbeFeatureGroup;
  return yield* GCP.AIPlatform.FeatureGroupsFeature("ProbeGroupFeature", {
    featureGroup: group.name,
    location,
    versionColumnName: "age",
  });
});
export const ProbeFeatureView = Effect.gen(function* () {
  const store = yield* ProbeFeatureOnlineStore;
  const group = yield* ProbeFeatureGroup;
  const feature = yield* ProbeGroupFeature;
  return yield* GCP.AIPlatform.FeatureOnlineStoresFeatureView("ProbeFeatureView", {
    featureOnlineStore: store.name,
    location,
    featureRegistrySource: {
      featureGroups: [{ featureGroupId: group.featureGroupId, featureIds: [feature.featureId] }],
    },
    syncConfig: { cron: "0 * * * *" },
  });
});

const PipelineRoot = GCP.Storage.Bucket("ProbePipelineRoot", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});
/** A paused schedule: it never starts a run. */
export const ProbeSchedule = Effect.gen(function* () {
  const bucket = yield* PipelineRoot;
  return yield* GCP.AIPlatform.Schedule("ProbeSchedule", {
    location,
    displayName: "probe-nightly",
    cron: "0 8 * * *",
    paused: true,
    maxRunCount: "1",
    createPipelineJobRequest: {
      pipelineJob: {
        displayName: "probe-hello",
        templateUri: "https://us-kfp.pkg.dev/ml-pipeline/google-cloud-registry/hello-world/latest",
        runtimeConfig: { gcsOutputDirectory: Output.interpolate`gs://${bucket.bucketName}/runs` },
      },
    },
  });
});

const echoWorkerPool = {
  machineSpec: { machineType: "n1-standard-4" },
  replicaCount: "1",
  containerSpec: {
    imageUri: "us-docker.pkg.dev/vertex-ai/training/tf-cpu.2-12.py310:latest",
    command: ["echo", "ok"],
  },
};
/** One echo trial: the job finishes in minutes. */
export const ProbeHyperparameterTuningJob = GCP.AIPlatform.HyperparameterTuningJob(
  "ProbeHyperparameterTuningJob",
  {
    location,
    displayName: "alchemy-probe-hpt",
    maxTrialCount: 1,
    parallelTrialCount: 1,
    studySpec: {
      metrics: [{ metricId: "accuracy", goal: "MAXIMIZE" }],
      parameters: [{ parameterId: "lr", doubleValueSpec: { minValue: 0.001, maxValue: 0.1 } }],
    },
    trialJobSpec: { workerPoolSpecs: [echoWorkerPool] },
  },
);
export const ProbeNasJob = GCP.AIPlatform.NasJob("ProbeNasJob", {
  location,
  displayName: "alchemy-probe-nas",
  nasJobSpec: {
    searchSpaceSpec: "{}",
    multiTrialAlgorithmSpec: {
      metric: { metricId: "accuracy", goal: "MAXIMIZE" },
      searchTrialSpec: {
        maxTrialCount: 1,
        maxParallelTrialCount: 1,
        searchTrialJobSpec: { workerPoolSpecs: [echoWorkerPool] },
      },
    },
  },
});
/** An empty pipeline: it completes without running a task. */
export const ProbePipelineJob = Effect.gen(function* () {
  const bucket = yield* PipelineRoot;
  return yield* GCP.AIPlatform.PipelineJob("ProbePipelineJob", {
    location,
    displayName: "alchemy-probe-pipeline",
    pipelineSpec: {
      pipelineInfo: { name: "alchemy-echo" },
      schemaVersion: "2.1.0",
      sdkVersion: "kfp-2.0.0",
      components: {},
      root: { dag: { tasks: {} } },
    },
    runtimeConfig: { gcsOutputDirectory: Output.interpolate`gs://${bucket.bucketName}/pipeline` },
  });
});
export const ProbeBatchPredictionJob = Effect.gen(function* () {
  const project = yield* deployProject;
  const bucket = yield* PipelineRoot;
  return yield* GCP.AIPlatform.BatchPredictionJob("ProbeBatchPredictionJob", {
    location,
    displayName: "alchemy-probe-batch",
    model: `projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash`,
    inputConfig: {
      instancesFormat: "jsonl",
      gcsSource: { uris: ["gs://cloud-samples-data/vertex-ai/batch.jsonl"] },
    },
    outputConfig: {
      predictionsFormat: "jsonl",
      gcsDestination: { outputUriPrefix: Output.interpolate`gs://${bucket.bucketName}/batch/` },
    },
  });
});
export const ProbeEvaluationRun = Effect.gen(function* () {
  const set = yield* ProbeEvaluationSet;
  return yield* GCP.AIPlatform.EvaluationRun("ProbeEvaluationRun", {
    location,
    displayName: "alchemy-probe-eval-run",
    dataSource: { evaluationSet: set.name },
    evaluationConfig: {
      metrics: [
        {
          metric: "instruction_following_v1",
          predefinedMetricSpec: { metricSpecName: "instruction_following_v1" },
        },
      ],
    },
  });
});

/** The agent a semantic governance policy governs (AgentService is served only in `global`). */
export const ProbeGovernedAgent = GCP.AIPlatform.Agent("ProbeGovernedAgent", {
  location: "global",
  systemInstruction: "Answer briefly.",
});
export const ProbeSemanticGovernancePolicy = Effect.gen(function* () {
  const agent = yield* ProbeGovernedAgent;
  return yield* GCP.AIPlatform.SemanticGovernancePolicy("ProbeSemanticGovernancePolicy", {
    location: "global",
    displayName: "alchemy-probe",
    agent: agent.name,
    naturalLanguageConstraint: "Never share customer PII.",
  });
});

/** A corpus, once the region's RAG Engine is serverless (Spanner mode is allowlisted here). */
export const ProbeRagEngine = GCP.AIPlatform.RagEngineConfig("ProbeRagEngine", {
  location,
  mode: "serverless",
});
export const ProbeRagCorpora = Effect.gen(function* () {
  const rag = yield* ProbeRagEngine;
  return yield* GCP.AIPlatform.RagCorpora("ProbeRagCorpora", {
    location: rag.location,
    displayName: "alchemy-probe",
  });
});

/** A one-machine persistent training pool (~15 minutes to provision). */
export const ProbePersistentResource = GCP.AIPlatform.PersistentResource(
  "ProbePersistentResource",
  {
    location,
    displayName: "alchemy-probe",
    resourcePools: [
      { id: "worker", replicaCount: "1", machineSpec: { machineType: "n1-standard-4" } },
    ],
  },
);
