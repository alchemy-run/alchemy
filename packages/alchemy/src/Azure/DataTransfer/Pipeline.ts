import * as adt from "@distilled.cloud/azure/azuredatatransfer";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDataTransferName,
  type DataTransferIdentity,
  type DataTransferObservedIdentity,
  identityDiffers,
  sameArm,
  sameList,
  toIdentityInput,
  toObservedIdentity,
} from "./Common.ts";

/** A subscriber notified about pipeline events. */
export interface PipelineSubscriber {
  /** Email address of the subscriber. */
  email?: string;
  /** Bit flags selecting which notifications the subscriber receives. */
  notifications?: number;
}

export interface PipelineProps {
  /** Resource group the pipeline is created in. Changing it replaces the pipeline. */
  resourceGroup: string;
  /**
   * Name of the pipeline, 3-64 letters, digits, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the pipeline.
   */
  name?: string;
  /**
   * Azure location of the pipeline. Changing it replaces the pipeline.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Remote cloud the pipeline sends data to or receives data from (e.g.
   * `Public`, `Government`). Changing it replaces the pipeline.
   */
  remoteCloud: string;
  /** Display name of the pipeline. */
  displayName?: string;
  /** Subscribers notified about pipeline events. */
  subscribers?: PipelineSubscriber[];
  /** Flow types disabled on this pipeline (e.g. `Mission`, `Messaging`). */
  disabledFlowTypes?: string[];
  /** Storage account used to download quarantined data. */
  quarantineDownloadStorageAccount?: string;
  /** Storage container used to download quarantined data. */
  quarantineDownloadStorageContainer?: string;
  /**
   * Whether the pipeline accepts transfers.
   * @default "Enabled"
   */
  status?: "Enabled" | "Disabled";
  /** Managed identity of the pipeline. Omit to leave it unmanaged. */
  identity?: DataTransferIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Pipeline extends Resource<
  "Azure.DataTransfer.Pipeline",
  PipelineProps,
  {
    /** Name of the pipeline. */
    pipelineName: string;
    /** ARM resource ID of the pipeline. */
    pipelineId: string;
    /** Resource group that holds the pipeline. */
    resourceGroup: string;
    /** Location of the pipeline. */
    location: string;
    /** Remote cloud of the pipeline. */
    remoteCloud: string;
    /** Display name of the pipeline. */
    displayName: string | undefined;
    /** Status of the pipeline (`Enabled` or `Disabled`). */
    status: string | undefined;
    /** Provisioning state of the pipeline. */
    provisioningState: string | undefined;
    /** ARM IDs of the connections requested against this pipeline. */
    connections: string[];
    /** Observed managed identity. */
    identity: DataTransferObservedIdentity | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Data Transfer pipeline — the approved route data takes between
 * Azure and a remote (e.g. sovereign or air-gapped) cloud. Connections in
 * other subscriptions request access to a pipeline, and the pipeline owner
 * approves them before flows can move data.
 *
 * Creating pipelines requires a subscription onboarded to Azure Data
 * Transfer; other subscriptions are rejected with
 * `DataTransferPipelineNotAllowed`. Display name, subscribers, disabled
 * flow types, quarantine settings, and status are re-applied with a PUT;
 * tags and identity are patched.
 *
 * @see https://learn.microsoft.com/azure/azure-data-transfer/
 *
 * ### Creating a Pipeline
 * **Example:** Pipeline to the public cloud
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("transfer");
 * const pipeline = yield* Azure.DataTransfer.Pipeline("pipeline", {
 *   resourceGroup: group.resourceGroupName,
 *   remoteCloud: "Public",
 *   displayName: "Mission data",
 *   subscribers: [{ email: "ops@example.com", notifications: 1 }],
 * });
 * ```
 *
 * ### Disabling a Pipeline
 * **Example:** Stop accepting transfers
 * ```typescript
 * const pipeline = yield* Azure.DataTransfer.Pipeline("pipeline", {
 *   resourceGroup: group.resourceGroupName,
 *   remoteCloud: "Public",
 *   status: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Pipeline = Resource<Pipeline>("Azure.DataTransfer.Pipeline");

type ObservedPipeline = adt.GetPipelineResponse;

const getPipeline = (
  subscriptionId: string,
  resourceGroupName: string,
  pipelineName: string,
) =>
  orUndefinedIfNotFound(
    adt.GetPipeline({ subscriptionId, resourceGroupName, pipelineName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  pipeline: ObservedPipeline,
): Pipeline["Attributes"] => ({
  pipelineName: name,
  pipelineId: pipeline.id ?? "",
  resourceGroup,
  location: pipeline.location,
  remoteCloud: pipeline.properties?.remoteCloud ?? "",
  displayName: pipeline.properties?.displayName,
  status: pipeline.properties?.status,
  provisioningState: pipeline.properties?.provisioningState,
  connections: (pipeline.properties?.connections ?? []).map((c) => c.id),
  identity: toObservedIdentity(pipeline.identity),
  tags: userTags(pipeline.tags),
});

const sameSubscribers = (
  desired: ReadonlyArray<PipelineSubscriber> | undefined,
  observed: ReadonlyArray<adt.Subscriber> | undefined,
) => {
  const key = (s: PipelineSubscriber) =>
    `${(s.email ?? "").toLowerCase()}|${s.notifications ?? ""}`;
  return sameList((desired ?? []).map(key), (observed ?? []).map(key));
};

/** Whether the PUT-only properties differ from what is observed. */
const propertiesDiffer = (news: PipelineProps, observed: ObservedPipeline) => {
  const props = observed.properties;
  return (
    (news.displayName !== undefined &&
      news.displayName !== props?.displayName) ||
    (news.subscribers !== undefined &&
      !sameSubscribers(news.subscribers, props?.subscribers)) ||
    (news.disabledFlowTypes !== undefined &&
      !sameList(news.disabledFlowTypes, props?.disabledFlowTypes)) ||
    (news.quarantineDownloadStorageAccount !== undefined &&
      news.quarantineDownloadStorageAccount !==
        props?.quarantineDownloadStorageAccount) ||
    (news.quarantineDownloadStorageContainer !== undefined &&
      news.quarantineDownloadStorageContainer !==
        props?.quarantineDownloadStorageContainer) ||
    (news.status !== undefined && !sameArm(news.status, props?.status))
  );
};

export const PipelineProvider = () =>
  Provider.succeed(Pipeline, {
    stables: ["pipelineName", "pipelineId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* adt
        .ListPipelineBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPipelineBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((pipeline) => {
        const group = resourceGroupOf(pipeline.id);
        return hasAnyAlchemyTag(pipeline.tags) &&
          group !== undefined &&
          pipeline.name !== undefined
          ? [toAttrs(group, pipeline.name, pipeline)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.pipelineName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (output.remoteCloud !== "" &&
          !sameArm(news.remoteCloud, output.remoteCloud))
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
        output?.pipelineName ??
        olds?.name ??
        (yield* createDataTransferName(id));
      const observed = yield* getPipeline(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureDataTransfer");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.pipelineName ??
        (yield* createDataTransferName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getPipeline(subscriptionId, resourceGroup, name);
      const label = `data transfer pipeline ${name}`;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        pipelineName: name,
      };

      // Observe.
      let observed = yield* get;

      // Ensure + sync PUT-only properties: the PUT is a full upsert.
      if (observed === undefined || propertiesDiffer(news, observed)) {
        yield* adt.PipelinesCreateOrUpdate({
          ...where,
          location: observed?.location ?? location,
          tags,
          identity: toIdentityInput(news.identity),
          properties: {
            remoteCloud: news.remoteCloud,
            displayName: news.displayName,
            subscribers: news.subscribers,
            disabledFlowTypes: news.disabledFlowTypes,
            quarantineDownloadStorageAccount:
              news.quarantineDownloadStorageAccount,
            quarantineDownloadStorageContainer:
              news.quarantineDownloadStorageContainer,
            status: news.status,
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (p) => p.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      // Sync tags and identity against the observed state.
      if (
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, news.identity)
      ) {
        yield* adt.UpdatePipeline({
          ...where,
          tags,
          identity: toIdentityInput(news.identity),
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (p) => p.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        adt.DeletePipeline({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          pipelineName: output.pipelineName,
        }),
      );
      yield* waitUntilGone(
        `data transfer pipeline ${output.pipelineName}`,
        getPipeline(subscriptionId, output.resourceGroup, output.pipelineName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
