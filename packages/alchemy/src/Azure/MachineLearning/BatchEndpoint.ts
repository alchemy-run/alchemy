import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  identityDiffers,
  type MachineLearningIdentity,
  sameArm,
  toArmIdentity,
  workspaceLocation,
} from "./Common.ts";

import type { EndpointAuthMode } from "./OnlineEndpoint.ts";

export interface BatchEndpointProps {
  /** Resource group of the workspace. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Workspace that owns the endpoint. Changing it replaces the endpoint. */
  workspace: string;
  /**
   * Endpoint name: 3-32 letters, digits, and hyphens, starting with a
   * letter, unique within the Azure region (it is part of the scoring
   * URI). If omitted, a unique name is generated from the logical ID.
   * Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the endpoint.
   * @default the workspace's location
   */
  location?: string;
  /**
   * How clients authenticate. Batch endpoints support only `AADToken`.
   * Changing it replaces the endpoint.
   * @default "AADToken"
   */
  authMode?: EndpointAuthMode;
  /** Description of the endpoint. */
  description?: string;
  /**
   * Name of the deployment that serves invocations that do not name one.
   * The deployment must exist, so set it in a deploy after it is created.
   */
  defaultDeployment?: string;
  /**
   * Managed identity of the endpoint's deployments.
   * @default { type: "SystemAssigned" }
   */
  identity?: MachineLearningIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BatchEndpoint extends Resource<
  "Azure.MachineLearning.BatchEndpoint",
  BatchEndpointProps,
  {
    /** Name of the endpoint. */
    endpointName: string;
    /** ARM resource ID of the endpoint. */
    endpointId: string;
    /** Workspace that owns the endpoint. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** Authentication mode. */
    authMode: string;
    /** Scoring URI clients call. */
    scoringUri: string | undefined;
    /** Name of the default deployment, if any. */
    defaultDeployment: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A batch inference endpoint in an Azure Machine Learning workspace — a
 * stable URI that runs asynchronous scoring jobs over large datasets on
 * an `AmlCompute` cluster through its `BatchDeployment`s.
 *
 * An endpoint has no hourly charge; compute is billed only while jobs run.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-endpoints-batch
 *
 * ### Creating an Endpoint
 * **Example:** Batch endpoint
 * ```typescript
 * const endpoint = yield* Azure.MachineLearning.BatchEndpoint("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   description: "Nightly scoring",
 * });
 * ```
 *
 * ### Default Deployment
 * **Example:** Route invocations to a deployment (after it exists)
 * ```typescript
 * const endpoint = yield* Azure.MachineLearning.BatchEndpoint("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   defaultDeployment: "v1",
 * });
 * ```
 *
 * @resource
 */
export const BatchEndpoint = Resource<BatchEndpoint>(
  "Azure.MachineLearning.BatchEndpoint",
);

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetBatchEndpoint({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      endpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  endpoint: ml.GetBatchEndpointResponse,
): BatchEndpoint["Attributes"] => ({
  endpointName: name,
  endpointId: endpoint.id ?? "",
  workspace,
  resourceGroup,
  location: endpoint.location,
  authMode: endpoint.properties.authMode,
  scoringUri: endpoint.properties.scoringUri,
  defaultDeployment: endpoint.properties.defaults?.deploymentName,
  principalId: endpoint.identity?.principalId,
  tags: userTags(endpoint.tags),
});

export const BatchEndpointProvider = () =>
  Provider.succeed(BatchEndpoint, {
    stables: [
      "endpointName",
      "endpointId",
      "workspace",
      "resourceGroup",
      "location",
      "authMode",
      "scoringUri",
    ],

    // Endpoints are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      if (!isResolved(news.resourceGroup) || !isResolved(news.workspace)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.endpointName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.authMode ?? "AADToken", output.authMode)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.endpointName ?? olds?.name ?? (yield* createChildName(id, 32));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.endpointName ?? (yield* createChildName(id, 32));
      const tags = yield* desiredTags(id, news.tags);
      const identity = news.identity ?? { type: "SystemAssigned" as const };
      const authMode = news.authMode ?? "AADToken";
      const get = getEndpoint(subscriptionId, resourceGroup, workspace, name);
      const waitReady = waitForProvisioned(
        `machine learning batch endpoint ${name}`,
        get,
        (endpoint) => endpoint.properties.provisioningState,
        { interval: "5 seconds", times: 90 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is an idempotent long-running upsert of the
      // whole endpoint; send it when missing or when any observed aspect
      // drifted from the desired state.
      const props = observed?.properties;
      const drifted =
        observed === undefined ||
        props === undefined ||
        (news.description !== undefined &&
          props.description !== news.description) ||
        (news.defaultDeployment !== undefined &&
          props.defaults?.deploymentName !== news.defaultDeployment) ||
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, identity);
      if (drifted) {
        const location =
          news.location ??
          output?.location ??
          observed?.location ??
          (yield* workspaceLocation(subscriptionId, resourceGroup, workspace));
        yield* ml.BatchEndpointsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          endpointName: name,
          location,
          tags,
          identity: toArmIdentity(identity),
          properties: {
            authMode,
            description: news.description,
            defaults: {
              deploymentName:
                news.defaultDeployment ?? props?.defaults?.deploymentName,
            },
          },
        });
      }
      observed = yield* waitReady;
      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteBatchEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          endpointName: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `machine learning batch endpoint ${output.endpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.endpointName,
        ),
        { interval: "5 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
