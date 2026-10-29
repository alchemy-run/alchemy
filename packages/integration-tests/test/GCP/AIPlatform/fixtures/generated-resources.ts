import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

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
