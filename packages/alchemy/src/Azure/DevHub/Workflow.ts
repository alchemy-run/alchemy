import * as developerhub from "@distilled.cloud/azure/developerhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** How the workflow deploys the application to Kubernetes. */
export interface WorkflowDeploymentProperties {
  /** Type of manifests in the repository: `helm`, `kube` or `kustomize`. */
  manifestType?: "helm" | "kube" | "kustomize" | (string & {});
  /** Paths of the Kubernetes manifests in the repository. */
  kubeManifestLocations?: string[];
  /** Helm chart directory path in the repository. */
  helmChartPath?: string;
  /** Location of the Helm `values.yaml` file in the repository. */
  helmValues?: string;
  /** Manifest override values. */
  overrides?: Record<string, string>;
}

/** Azure Container Registry the workflow pushes images to. */
export interface WorkflowAcr {
  /** Subscription ID of the registry. */
  acrSubscriptionId?: string;
  /** Resource group of the registry. */
  acrResourceGroup?: string;
  /** Name of the registry. */
  acrRegistryName?: string;
  /** Repository inside the registry. */
  acrRepositoryName?: string;
}

/** GitHub repository and deployment target of the workflow. */
export interface WorkflowGitHubProfile {
  /** Owner (user or organisation) of the GitHub repository. */
  repositoryOwner?: string;
  /** Name of the GitHub repository. */
  repositoryName?: string;
  /** Branch the workflow pull request targets. */
  branchName?: string;
  /** Path of the Dockerfile within the repository. */
  dockerfile?: string;
  /** Path of the Docker build context within the repository. */
  dockerBuildContext?: string;
  /** How the application is deployed to the cluster. */
  deploymentProperties?: WorkflowDeploymentProperties;
  /** Kubernetes namespace the application is deployed to. */
  namespace?: string;
  /** Container registry the image is pushed to. */
  acr?: WorkflowAcr;
  /** Entra application used by GitHub Actions through OIDC federation. */
  oidcCredentials?: {
    /** Application (client) ID. */
    azureClientId?: string;
    /** Directory (tenant) ID. */
    azureTenantId?: string;
  };
  /** ARM resource ID of the AKS cluster the application is deployed to. */
  aksResourceId?: string;
}

/** Settings for generating a Dockerfile and manifests. */
export interface WorkflowArtifactGenerationProperties {
  /** Language of the application, e.g. `javascript`, `go`, `python`. */
  generationLanguage?: string;
  /** Language image version used to run the app in the generated Dockerfile. */
  languageVersion?: string;
  /** Language image version used to build the app in the generated Dockerfile. */
  builderVersion?: string;
  /** Port the application listens on. */
  port?: string;
  /** Name of the application. */
  appName?: string;
  /** Directory the generated Dockerfile is written to. */
  dockerfileOutputDirectory?: string;
  /** Directory the generated manifests are written to. */
  manifestOutputDirectory?: string;
  /** Whether to generate a Dockerfile: `enabled` or `disabled`. */
  dockerfileGenerationMode?: "enabled" | "disabled" | (string & {});
  /** Whether to generate manifests: `enabled` or `disabled`. */
  manifestGenerationMode?: "enabled" | "disabled" | (string & {});
  /** Type of generated manifests: `helm` or `kube`. */
  manifestType?: "helm" | "kube" | (string & {});
  /** Name of the image to build. */
  imageName?: string;
  /** Kubernetes namespace to deploy to. */
  namespace?: string;
  /** Tag applied to the built image. */
  imageTag?: string;
}

export interface WorkflowProps {
  /**
   * Resource group the workflow is created in. Changing it replaces the
   * workflow.
   */
  resourceGroup: string;
  /**
   * Name of the workflow (1-63 characters of letters, digits, `-` and `_`).
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the workflow.
   */
  name?: string;
  /**
   * Azure location of the workflow. Changing it replaces the workflow.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * GitHub repository, registry and AKS cluster the workflow wires
   * together. Creating the workflow opens a pull request against the
   * repository, which requires the Developer Hub GitHub app to be
   * authorized for the subscription. Changing it replaces the workflow.
   */
  githubWorkflowProfile?: WorkflowGitHubProfile;
  /**
   * Dockerfile/manifest generation settings. Changing them replaces the
   * workflow.
   */
  artifactGenerationProperties?: WorkflowArtifactGenerationProperties;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workflow extends Resource<
  "Azure.DevHub.Workflow",
  WorkflowProps,
  {
    /** Name of the workflow. */
    workflowName: string;
    /** Resource group that holds the workflow. */
    resourceGroup: string;
    /** ARM resource ID of the workflow. */
    workflowId: string;
    /** Location of the workflow. */
    location: string;
    /** URL of the pull request opened against the repository. */
    prURL: string | undefined;
    /** Number of the pull request opened against the repository. */
    pullNumber: number | undefined;
    /** Status of the pull request: `unknown`, `submitted`, `merged`, `removed`. */
    prStatus: string | undefined;
    /** GitHub authorization status: `Authorized`, `NotFound`, `Error`. */
    authStatus: string | undefined;
    /** Status of the last GitHub Actions run, if any. */
    lastWorkflowRunStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Developer Hub workflow (Automated Deployments for AKS). It connects a
 * GitHub repository to an AKS cluster and an Azure Container Registry, and
 * opens a pull request that adds a GitHub Actions workflow building the
 * image and deploying it to the cluster.
 *
 * The subscription must first authorize the Developer Hub GitHub app
 * (Azure portal → AKS → Automated deployments).
 *
 * @see https://learn.microsoft.com/azure/aks/automated-deployments
 *
 * ### Creating a Workflow
 * **Example:** Deploy a repository to AKS with Helm
 * ```typescript
 * const workflow = yield* Azure.DevHub.Workflow("deploy", {
 *   resourceGroup: group.resourceGroupName,
 *   githubWorkflowProfile: {
 *     repositoryOwner: "my-org",
 *     repositoryName: "my-app",
 *     branchName: "main",
 *     dockerfile: "./Dockerfile",
 *     dockerBuildContext: ".",
 *     deploymentProperties: {
 *       manifestType: "helm",
 *       helmChartPath: "./charts/app",
 *       helmValues: "./charts/app/values.yaml",
 *     },
 *     namespace: "default",
 *     acr: {
 *       acrSubscriptionId: subscriptionId,
 *       acrResourceGroup: group.resourceGroupName,
 *       acrRegistryName: registry.registryName,
 *       acrRepositoryName: "my-app",
 *     },
 *     oidcCredentials: { azureClientId: clientId, azureTenantId: tenantId },
 *     aksResourceId: cluster.clusterId,
 *   },
 * });
 * ```
 *
 * ### Generating a Dockerfile and Manifests
 * **Example:** Let Developer Hub generate the build artifacts
 * ```typescript
 * const workflow = yield* Azure.DevHub.Workflow("deploy", {
 *   resourceGroup: group.resourceGroupName,
 *   githubWorkflowProfile: { ...profile },
 *   artifactGenerationProperties: {
 *     generationLanguage: "javascript",
 *     languageVersion: "20",
 *     port: "3000",
 *     appName: "my-app",
 *     dockerfileGenerationMode: "enabled",
 *     manifestGenerationMode: "enabled",
 *     manifestType: "kube",
 *     imageName: "my-app",
 *     imageTag: "latest",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Workflow = Resource<Workflow>("Azure.DevHub.Workflow");

type ObservedWorkflow = developerhub.GetWorkflowResponse;

const getWorkflow = (
  subscriptionId: string,
  resourceGroupName: string,
  workflowName: string,
) =>
  orUndefinedIfNotFound(
    developerhub.GetWorkflow({
      subscriptionId,
      resourceGroupName,
      workflowName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workflow: ObservedWorkflow,
): Workflow["Attributes"] => {
  const profile = workflow.properties?.githubWorkflowProfile;
  return {
    workflowName: name,
    resourceGroup,
    workflowId: workflow.id ?? "",
    location: workflow.location,
    prURL: profile?.prURL,
    pullNumber: profile?.pullNumber,
    prStatus: profile?.prStatus,
    authStatus: profile?.authStatus,
    lastWorkflowRunStatus: profile?.lastWorkflowRun?.workflowRunStatus,
    tags: userTags(workflow.tags),
  };
};

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63 });

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const WorkflowProvider = () =>
  Provider.succeed(Workflow, {
    stables: ["workflowName", "resourceGroup", "workflowId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* developerhub
        .ListWorkflow({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListWorkflow", page)),
        );
      return (page.value ?? []).flatMap((workflow) => {
        const group = resourceGroupOf(workflow.id);
        return hasAnyAlchemyTag(workflow.tags) &&
          group !== undefined &&
          workflow.name !== undefined
          ? [toAttrs(group, workflow.name, workflow)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workflowName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      // The repository, cluster and generation settings are fixed once the
      // workflow (and its pull request) exist; only tags are patchable.
      if (
        olds !== undefined &&
        (!sameJson(news.githubWorkflowProfile, olds.githubWorkflowProfile) ||
          !sameJson(
            news.artifactGenerationProperties,
            olds.artifactGenerationProperties,
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.workflowName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getWorkflow(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevHub");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workflowName ?? (yield* physicalName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getWorkflow(subscriptionId, resourceGroup, name);

      // Ensure: the PUT is synchronous.
      if (observed === undefined) {
        observed = yield* developerhub.WorkflowCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workflowName: name,
          location,
          tags,
          properties: {
            githubWorkflowProfile: news.githubWorkflowProfile,
            artifactGenerationProperties: news.artifactGenerationProperties,
          },
        });
      }

      // Sync tags (the only mutable aspect) against observed tags.
      if (tagsDiffer(observed.tags, tags)) {
        observed = yield* developerhub.UpdateWorkflowTags({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workflowName: name,
          tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        developerhub.DeleteWorkflow({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workflowName: output.workflowName,
        }),
      );
      yield* waitUntilGone(
        `devhub workflow ${output.workflowName}`,
        getWorkflow(subscriptionId, output.resourceGroup, output.workflowName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
