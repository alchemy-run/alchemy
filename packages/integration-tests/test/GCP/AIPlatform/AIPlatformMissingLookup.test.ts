import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:aiplatform", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const underscored = name.replace(/-/g, "_");
      yield* expectAllMissing(stack, {
        "missing-deployment-resource-pool": GCP.AIPlatform.DeploymentResourcePool.lookup({
          deploymentResourcePoolId: name,
        }).name,
        "missing-endpoint": GCP.AIPlatform.Endpoint.lookup({ endpointId: name }).name,
        "missing-feature-group": GCP.AIPlatform.FeatureGroup.lookup({ featureGroupId: underscored })
          .name,
        "missing-feature-groups-feature": GCP.AIPlatform.FeatureGroupsFeature.lookup({
          featureId: underscored,
          featureGroup: underscored,
        }).name,
        "missing-feature-online-store": GCP.AIPlatform.FeatureOnlineStore.lookup({
          featureOnlineStoreId: underscored,
        }).name,
        "missing-feature-online-stores-feature-view":
          GCP.AIPlatform.FeatureOnlineStoresFeatureView.lookup({
            featureViewId: underscored,
            featureOnlineStore: underscored,
          }).name,
        "missing-featurestore": GCP.AIPlatform.Featurestore.lookup({ featurestoreId: underscored })
          .name,
        "missing-featurestores-entity-type": GCP.AIPlatform.FeaturestoresEntityType.lookup({
          entityTypeId: underscored,
          featurestore: underscored,
        }).name,
        "missing-featurestores-entity-types-feature":
          GCP.AIPlatform.FeaturestoresEntityTypesFeature.lookup({
            featureId: name,
            entityType: name,
          }).name,
        "missing-metadata-store": GCP.AIPlatform.MetadataStore.lookup({ metadataStoreId: name })
          .name,
        "missing-metadata-stores-artifact": GCP.AIPlatform.MetadataStoresArtifact.lookup({
          artifactId: name,
          metadataStore: name,
        }).name,
        "missing-metadata-stores-context": GCP.AIPlatform.MetadataStoresContext.lookup({
          contextId: name,
          metadataStore: name,
        }).name,
        "missing-metadata-stores-execution": GCP.AIPlatform.MetadataStoresExecution.lookup({
          executionId: name,
          metadataStore: name,
        }).name,
        "missing-notebook-execution-job": GCP.AIPlatform.NotebookExecutionJob.lookup({
          notebookExecutionJobId: name,
        }).name,
        "missing-notebook-runtime-template": GCP.AIPlatform.NotebookRuntimeTemplate.lookup({
          notebookRuntimeTemplateId: name,
        }).name,
        "missing-persistent-resource": GCP.AIPlatform.PersistentResource.lookup({
          persistentResourceId: name,
        }).name,
        "missing-pipeline-job": GCP.AIPlatform.PipelineJob.lookup({ pipelineJobId: name }).name,
        "missing-reasoning-engines-memory": GCP.AIPlatform.ReasoningEnginesMemory.lookup({
          memoryId: "1234567890",
          reasoningEngine: "1234567890",
        }).name,
        "missing-reasoning-engines-session": GCP.AIPlatform.ReasoningEnginesSession.lookup({
          sessionId: name,
          parent: name,
        }).name,
        "missing-semantic-governance-policy": GCP.AIPlatform.SemanticGovernancePolicy.lookup({
          semanticGovernancePolicyId: name,
        }).name,
        "missing-tensorboard": GCP.AIPlatform.Tensorboard.lookup({ displayName: name }).name,
        "missing-tensorboards-experiment": GCP.AIPlatform.TensorboardsExperiment.lookup({
          experimentId: name,
          parent: name,
        }).name,
        "missing-tensorboards-experiments-run": GCP.AIPlatform.TensorboardsExperimentsRun.lookup({
          runId: name,
          parent: name,
        }).name,
      });
    }),
  { tags, timeout: 405000 },
);
