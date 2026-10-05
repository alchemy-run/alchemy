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
  sameValue,
  toArmIdentity,
  workspaceLocation,
  inputFields,
} from "./Common.ts";

export type EndpointAuthMode = "Key" | "AMLToken" | "AADToken";

export interface OnlineEndpointProps {
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
   * How clients authenticate to the scoring URI. Changing it replaces the
   * endpoint.
   * @default "Key"
   */
  authMode?: EndpointAuthMode;
  /**
   * ARM resource ID of a Kubernetes compute to host the endpoint on
   * (omit for a managed endpoint). Changing it replaces the endpoint.
   */
  compute?: string;
  /**
   * Description of the endpoint. Azure ignores description changes on an
   * existing endpoint, so changing it replaces the endpoint.
   */
  description?: string;
  /**
   * Percentage of live traffic per deployment name. Deployments must exist
   * before traffic can point at them, so set it in a deploy after the
   * deployments are created.
   */
  traffic?: Record<string, number>;
  /** Percentage of live traffic mirrored to each deployment. */
  mirrorTraffic?: Record<string, number>;
  /**
   * Whether the scoring endpoint accepts public traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
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

export interface OnlineEndpoint extends Resource<
  "Azure.MachineLearning.OnlineEndpoint",
  OnlineEndpointProps,
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
    /** Swagger URI of the endpoint. */
    swaggerUri: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A managed online (real-time) inference endpoint in an Azure Machine
 * Learning workspace. The endpoint is the stable scoring URI and auth
 * boundary; `OnlineDeployment`s behind it run the model and share its
 * traffic.
 *
 * An endpoint without deployments has no compute and no hourly charge.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online
 *
 * ### Creating an Endpoint
 * **Example:** Key-authenticated endpoint
 * ```typescript
 * const endpoint = yield* Azure.MachineLearning.OnlineEndpoint("scoring", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   description: "Real-time scoring",
 * });
 * ```
 *
 * ### Routing Traffic
 * **Example:** Send all traffic to a deployment (after it exists)
 * ```typescript
 * const endpoint = yield* Azure.MachineLearning.OnlineEndpoint("scoring", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   traffic: { blue: 100 },
 * });
 * ```
 *
 * @resource
 */
export const OnlineEndpoint = Resource<OnlineEndpoint>(
  "Azure.MachineLearning.OnlineEndpoint",
);

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetOnlineEndpoint({
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
  endpoint: ml.GetOnlineEndpointResponse,
): OnlineEndpoint["Attributes"] => ({
  endpointName: name,
  endpointId: endpoint.id ?? "",
  workspace,
  resourceGroup,
  location: endpoint.location,
  authMode: endpoint.properties.authMode,
  scoringUri: endpoint.properties.scoringUri ?? undefined,
  swaggerUri: endpoint.properties.swaggerUri ?? undefined,
  principalId: endpoint.identity?.principalId,
  tags: userTags(endpoint.tags),
});

const sameTraffic = (
  observed: Record<string, number | undefined> | null | undefined,
  desired: Record<string, number> | undefined,
) =>
  desired === undefined ||
  sameValue(
    Object.fromEntries(
      Object.entries(observed ?? {}).filter(([, v]) => v !== 0),
    ),
    Object.fromEntries(Object.entries(desired).filter(([, v]) => v !== 0)),
  );

export const OnlineEndpointProvider = () =>
  Provider.succeed(OnlineEndpoint, {
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

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.endpointName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.authMode ?? "Key", output.authMode) ||
        (olds !== undefined &&
          (!sameArm(news.compute, olds.compute) ||
            (news.description ?? "") !== (olds.description ?? "")))
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
      const authMode = news.authMode ?? "Key";
      const get = getEndpoint(subscriptionId, resourceGroup, workspace, name);
      const waitReady = waitForProvisioned(
        `machine learning online endpoint ${name}`,
        get,
        // Right after a PUT the GET can still report the previous tags and
        // traffic split as `Succeeded`; only the desired state counts.
        (endpoint) => {
          const state = endpoint.properties.provisioningState;
          if (state !== undefined && state !== "Succeeded") return state;
          return !tagsDiffer(endpoint.tags, tags) &&
            sameTraffic(endpoint.properties.traffic, news.traffic) &&
            sameTraffic(endpoint.properties.mirrorTraffic, news.mirrorTraffic)
            ? "Succeeded"
            : "Updating";
        },
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
        (news.publicNetworkAccess !== undefined &&
          props.publicNetworkAccess !== news.publicNetworkAccess) ||
        !sameTraffic(props.traffic, news.traffic) ||
        !sameTraffic(props.mirrorTraffic, news.mirrorTraffic) ||
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, identity);
      if (drifted) {
        const location =
          news.location ??
          output?.location ??
          observed?.location ??
          (yield* workspaceLocation(subscriptionId, resourceGroup, workspace));
        yield* ml.OnlineEndpointsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          endpointName: name,
          location,
          tags,
          identity: toArmIdentity(identity),
          properties: {
            authMode,
            compute: news.compute,
            description: news.description,
            traffic: news.traffic ?? props?.traffic,
            mirrorTraffic: news.mirrorTraffic ?? props?.mirrorTraffic,
            publicNetworkAccess: news.publicNetworkAccess,
          },
        });
      }
      observed = yield* waitReady;
      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteOnlineEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          endpointName: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `machine learning online endpoint ${output.endpointName}`,
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
