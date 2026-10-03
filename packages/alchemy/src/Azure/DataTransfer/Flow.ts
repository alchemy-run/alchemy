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

/** Options of an API flow. */
export interface FlowApiOptions {
  /** Unique CNAME representing the API flow instance. */
  cname?: string;
  /** How the API flow is invoked: through the SDK or an endpoint. */
  apiMode?: "SDK" | "Endpoint";
}

/** Marketplace plan of a flow. */
export interface FlowPlan {
  /** Name of the plan. */
  name: string;
  /** Publisher of the plan. */
  publisher: string;
  /** Product (offer ID) of the plan. */
  product: string;
  /** Promotion code. */
  promotionCode?: string;
  /** Version of the product. */
  version?: string;
}

export interface FlowProps {
  /** Resource group of the connection. Changing it replaces the flow. */
  resourceGroup: string;
  /** Name of the connection that owns the flow. Changing it replaces the flow. */
  connection: string;
  /**
   * Name of the flow, 3-64 letters, digits, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the flow.
   */
  name?: string;
  /**
   * Azure location of the flow. Changing it replaces the flow.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Flow type (e.g. `Mission`, `Messaging`, `StreamingVideo`, `API`).
   * Changing it replaces the flow.
   */
  flowType?: string;
  /** Type of data transferred (`Blob` or `Table`). Changing it replaces the flow. */
  dataType?: "Blob" | "Table";
  /** ARM ID of the destination storage account. Changing it replaces the flow. */
  storageAccountId?: string;
  /** Destination storage container. Changing it replaces the flow. */
  storageContainerName?: string;
  /** Destination storage table. Changing it replaces the flow. */
  storageTableName?: string;
  /** ARM ID of the destination Service Bus queue. Changing it replaces the flow. */
  serviceBusQueueId?: string;
  /** ARM ID of the destination Event Hub. Changing it replaces the flow. */
  eventHubId?: string;
  /** Event Hub consumer group. Changing it replaces the flow. */
  consumerGroup?: string;
  /** URI of a Key Vault secret holding a SAS token. Changing it replaces the flow. */
  keyVaultUri?: string;
  /** URI of the customer-managed key. Changing it replaces the flow. */
  customerManagedKeyVaultUri?: string;
  /** Billing tier of a messaging flow. Changing it replaces the flow. */
  billingTier?: "BlobTransport" | "Standard" | "Premium";
  /** API flow options. Changing them replaces the flow. */
  apiFlowOptions?: FlowApiOptions;
  /** Stream identifier. Changing it replaces the flow. */
  streamId?: string;
  /** Stream protocol. Changing it replaces the flow. */
  streamProtocol?: "UDP" | "SRT" | "RTP";
  /** Stream latency in milliseconds. Changing it replaces the flow. */
  streamLatency?: number;
  /** Passphrase for SRT streams (non-secret). Updated in place. */
  passphrase?: string;
  /** Source IP addresses or CIDR ranges of the stream. Updated in place. */
  sourceAddresses?: string[];
  /** Destination endpoints of the stream. Updated in place. */
  destinationEndpoints?: string[];
  /** Destination endpoint ports of the stream. Updated in place. */
  destinationEndpointPorts?: number[];
  /**
   * Whether the flow moves data. Driven by the enable/disable actions.
   * @default left as Azure sets it
   */
  status?: "Enabled" | "Disabled";
  /** Marketplace plan of the flow. Changing it replaces the flow. */
  plan?: FlowPlan;
  /** Managed identity of the flow. Omit to leave it unmanaged. */
  identity?: DataTransferIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Flow extends Resource<
  "Azure.DataTransfer.Flow",
  FlowProps,
  {
    /** Name of the flow. */
    flowName: string;
    /** ARM resource ID of the flow. */
    flowId: string;
    /** Dataflow GUID of the flow. */
    dataflowId: string | undefined;
    /** Name of the connection that owns the flow. */
    connection: string;
    /** Resource group of the connection. */
    resourceGroup: string;
    /** Location of the flow. */
    location: string;
    /** Flow type. */
    flowType: string | undefined;
    /** Status of the flow (`Enabled` or `Disabled`). */
    status: string | undefined;
    /** Whether the flow is linked to its remote counterpart. */
    linkStatus: string | undefined;
    /** ARM ID of the linked remote flow. */
    linkedFlowId: string | undefined;
    /** Provisioning state of the flow. */
    provisioningState: string | undefined;
    /** Billing tier of a messaging flow. */
    billingTier: string | undefined;
    /** Observed managed identity. */
    identity: DataTransferObservedIdentity | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Data Transfer flow — moves data of one type through an
 * approved connection into a destination (storage container or table,
 * Service Bus queue, Event Hub, stream, or API).
 *
 * Flows can only be created on a connection the pipeline owner approved;
 * otherwise Azure rejects the create with
 * `DataTransferConnectionNotApproved`. Status is driven by the
 * enable/disable actions, stream addresses, endpoints, ports, and
 * passphrase by their set actions, and tags and identity are patched;
 * every other property replaces the flow.
 *
 * @see https://learn.microsoft.com/azure/azure-data-transfer/
 *
 * ### Creating a Flow
 * **Example:** Blob flow into a storage container
 * ```typescript
 * const flow = yield* Azure.DataTransfer.Flow("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   connection: connection.connectionName,
 *   flowType: "Mission",
 *   dataType: "Blob",
 *   storageAccountId: account.storageAccountId,
 *   storageContainerName: "incoming",
 * });
 * ```
 *
 * ### Disabling a Flow
 * **Example:** Pause a flow without deleting it
 * ```typescript
 * const flow = yield* Azure.DataTransfer.Flow("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   connection: connection.connectionName,
 *   flowType: "Mission",
 *   dataType: "Blob",
 *   status: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Flow = Resource<Flow>("Azure.DataTransfer.Flow");

type ObservedFlow = adt.GetFlowResponse;

const getFlow = (
  subscriptionId: string,
  resourceGroupName: string,
  connectionName: string,
  flowName: string,
) =>
  orUndefinedIfNotFound(
    adt.GetFlow({
      subscriptionId,
      resourceGroupName,
      connectionName,
      flowName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  connection: string,
  name: string,
  flow: ObservedFlow,
): Flow["Attributes"] => ({
  flowName: name,
  flowId: flow.id ?? "",
  dataflowId: flow.properties?.flowId,
  connection,
  resourceGroup,
  location: flow.location,
  flowType: flow.properties?.flowType,
  status: flow.properties?.status,
  linkStatus: flow.properties?.linkStatus,
  linkedFlowId: flow.properties?.linkedFlowId,
  provisioningState: flow.properties?.provisioningState,
  billingTier: flow.properties?.messagingOptions?.billingTier,
  identity: toObservedIdentity(flow.identity),
  tags: userTags(flow.tags),
});

const differs = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

/** Request fields that can only change through a replacement. */
const replaceFields = [
  "flowType",
  "dataType",
  "storageAccountId",
  "storageContainerName",
  "storageTableName",
  "serviceBusQueueId",
  "eventHubId",
  "consumerGroup",
  "keyVaultUri",
  "customerManagedKeyVaultUri",
  "billingTier",
  "apiFlowOptions",
  "streamId",
  "streamProtocol",
  "streamLatency",
  "plan",
] as const satisfies ReadonlyArray<keyof FlowProps>;

export const FlowProvider = () =>
  Provider.succeed(Flow, {
    stables: [
      "flowName",
      "flowId",
      "dataflowId",
      "connection",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const connections = yield* adt
        .ListConnectionBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConnectionBySubscription", page),
          ),
        );
      const found: Flow["Attributes"][] = [];
      for (const connection of connections.value ?? []) {
        const group = resourceGroupOf(connection.id);
        if (group === undefined || connection.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          adt.ListFlowByConnection({
            subscriptionId,
            resourceGroupName: group,
            connectionName: connection.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListFlowByConnection", page);
        }
        for (const flow of page?.value ?? []) {
          if (hasAnyAlchemyTag(flow.tags) && flow.name !== undefined) {
            found.push(toAttrs(group, connection.name, flow.name, flow));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.connection, output.connection) ||
        (news.name !== undefined && !sameArm(news.name, output.flowName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        replaceFields.some((field) => differs(news[field], olds[field]))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const connection = output?.connection ?? olds?.connection;
      if (resourceGroup === undefined || connection === undefined) {
        return undefined;
      }
      const name =
        output?.flowName ?? olds?.name ?? (yield* createDataTransferName(id));
      const observed = yield* getFlow(
        subscriptionId,
        resourceGroup,
        connection,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, connection, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureDataTransfer");
      const { resourceGroup, connection } = news;
      const name =
        news.name ?? output?.flowName ?? (yield* createDataTransferName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getFlow(subscriptionId, resourceGroup, connection, name);
      const label = `data transfer flow ${name}`;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        connectionName: connection,
        flowName: name,
      };
      const wait = waitForProvisioned(
        label,
        get,
        (f) => f.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      const existing = yield* get;

      // Ensure.
      if (existing === undefined) {
        yield* adt.FlowsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentityInput(news.identity),
          plan: news.plan,
          properties: {
            connection: {
              id: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.AzureDataTransfer/connections/${connection}`,
            },
            flowType: news.flowType,
            dataType: news.dataType,
            storageAccountId: news.storageAccountId,
            storageContainerName: news.storageContainerName,
            storageTableName: news.storageTableName,
            serviceBusQueueId: news.serviceBusQueueId,
            eventHubId: news.eventHubId,
            consumerGroup: news.consumerGroup,
            keyVaultUri: news.keyVaultUri,
            customerManagedKeyVaultUri: news.customerManagedKeyVaultUri,
            messagingOptions:
              news.billingTier === undefined
                ? undefined
                : { billingTier: news.billingTier },
            apiFlowOptions: news.apiFlowOptions,
            streamId: news.streamId,
            streamProtocol: news.streamProtocol,
            streamLatency: news.streamLatency,
            passphrase: news.passphrase,
            sourceAddresses:
              news.sourceAddresses === undefined
                ? undefined
                : { sourceAddresses: news.sourceAddresses },
            destinationEndpoints: news.destinationEndpoints,
            destinationEndpointPorts: news.destinationEndpointPorts,
            status: news.status,
          },
        });
      }
      let observed = yield* wait;

      // Sync stream settings through their set actions.
      const props = observed.properties;
      if (
        news.sourceAddresses !== undefined &&
        !sameList(news.sourceAddresses, props?.sourceAddresses?.sourceAddresses)
      ) {
        yield* adt.SetFlowSourceAddresses({
          ...where,
          values: news.sourceAddresses,
        });
      }
      if (
        news.destinationEndpoints !== undefined &&
        !sameList(news.destinationEndpoints, props?.destinationEndpoints)
      ) {
        yield* adt.SetFlowDestinationEndpoints({
          ...where,
          endpoints: news.destinationEndpoints,
        });
      }
      if (
        news.destinationEndpointPorts !== undefined &&
        !sameList(
          news.destinationEndpointPorts.map(String),
          props?.destinationEndpointPorts?.map(String),
        )
      ) {
        yield* adt.SetFlowDestinationEndpointPorts({
          ...where,
          ports: news.destinationEndpointPorts,
        });
      }
      if (
        news.passphrase !== undefined &&
        news.passphrase !== props?.passphrase
      ) {
        yield* adt.SetFlowPassphrase({ ...where, value: news.passphrase });
      }

      // Sync status through the enable/disable actions.
      if (news.status !== undefined && !sameArm(news.status, props?.status)) {
        if (news.status === "Enabled") {
          yield* adt.EnableFlow(where);
        } else {
          yield* adt.DisableFlow(where);
        }
      }

      // Sync tags and identity.
      if (
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, news.identity)
      ) {
        yield* adt.UpdateFlow({
          ...where,
          tags,
          identity: toIdentityInput(news.identity),
        });
      }

      observed = yield* wait;
      return toAttrs(resourceGroup, connection, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        adt.DeleteFlow({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectionName: output.connection,
          flowName: output.flowName,
        }),
      );
      yield* waitUntilGone(
        `data transfer flow ${output.flowName}`,
        getFlow(
          subscriptionId,
          output.resourceGroup,
          output.connection,
          output.flowName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DataTransfer.Connection",
      ],
    },
  });
