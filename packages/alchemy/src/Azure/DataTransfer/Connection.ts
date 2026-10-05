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

export interface ConnectionProps {
  /** Resource group the connection is created in. Changing it replaces the connection. */
  resourceGroup: string;
  /**
   * Name of the connection, 3-64 letters, digits, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the connection.
   */
  name?: string;
  /**
   * Azure location of the connection. Changing it replaces the connection.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Name of the pipeline the connection requests access to. Changing it
   * replaces the connection.
   */
  pipeline: string;
  /**
   * Direction of data movement through the pipeline. Changing it replaces
   * the connection.
   */
  direction?: "Send" | "Receive";
  /**
   * Business justification shown to the pipeline approver. Changing it
   * replaces the connection.
   */
  justification?: string;
  /** Requirement ID of the connection. Changing it replaces the connection. */
  requirementId?: string;
  /**
   * Subscription ID in the remote cloud to link with. Changing it replaces
   * the connection.
   */
  remoteSubscriptionId?: string;
  /** PIN used to link the request with its remote counterpart. Changing it replaces the connection. */
  pin?: string;
  /** Primary contact for the connection request. Changing it replaces the connection. */
  primaryContact?: string;
  /** Secondary contacts for the connection request. Changing them replaces the connection. */
  secondaryContacts?: string[];
  /**
   * Flow types requested for the connection (e.g. `Mission`, `Messaging`).
   * Changing them replaces the connection.
   */
  flowTypes?: string[];
  /** Managed identity of the connection. Omit to leave it unmanaged. */
  identity?: DataTransferIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Connection extends Resource<
  "Azure.DataTransfer.Connection",
  ConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Resource group that holds the connection. */
    resourceGroup: string;
    /** Location of the connection. */
    location: string;
    /** Name of the pipeline the connection targets. */
    pipeline: string;
    /** Direction of data movement. */
    direction: string | undefined;
    /** Approval status (`InReview`, `Approved`, `Rejected`, `Accepted`). */
    status: string | undefined;
    /** Reason for the approval status. */
    statusReason: string | undefined;
    /** Whether the connection is linked to its remote counterpart. */
    linkStatus: string | undefined;
    /** ARM ID of the linked remote connection. */
    linkedConnectionId: string | undefined;
    /** Approver of the connection request. */
    approver: string | undefined;
    /** When the connection request was submitted. */
    dateSubmitted: string | undefined;
    /** Provisioning state of the connection. */
    provisioningState: string | undefined;
    /** Observed managed identity. */
    identity: DataTransferObservedIdentity | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Data Transfer connection — a request to use a pipeline for
 * moving data in one direction. The pipeline owner approves the request;
 * flows can only be created on an approved connection.
 *
 * The connection PUT is create-only (Azure rejects a second PUT with
 * `DataTransferConnectionAlreadyExists`), so every request property
 * replaces the connection; tags and identity are patched in place. A
 * connection whose pipeline does not exist ends in provisioning state
 * `Failed`, which surfaces as `Azure.ProvisioningFailed`.
 *
 * @see https://learn.microsoft.com/azure/azure-data-transfer/
 *
 * ### Requesting a Connection
 * **Example:** Send data through a pipeline
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("transfer");
 * const connection = yield* Azure.DataTransfer.Connection("outbound", {
 *   resourceGroup: group.resourceGroupName,
 *   pipeline: "mission-pipeline",
 *   direction: "Send",
 *   justification: "Nightly telemetry export",
 *   primaryContact: "ops@example.com",
 *   flowTypes: ["Mission"],
 * });
 * ```
 *
 * ### Tagging a Connection
 * **Example:** Tags are updated in place
 * ```typescript
 * const connection = yield* Azure.DataTransfer.Connection("outbound", {
 *   resourceGroup: group.resourceGroupName,
 *   pipeline: "mission-pipeline",
 *   direction: "Send",
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const Connection = Resource<Connection>("Azure.DataTransfer.Connection");

type ObservedConnection = adt.GetConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  connectionName: string,
) =>
  orUndefinedIfNotFound(
    adt.GetConnection({ subscriptionId, resourceGroupName, connectionName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  connection: ObservedConnection,
): Connection["Attributes"] => ({
  connectionName: name,
  connectionId: connection.id ?? "",
  resourceGroup,
  location: connection.location,
  pipeline: connection.properties?.pipeline ?? "",
  direction: connection.properties?.direction,
  status: connection.properties?.status,
  statusReason: connection.properties?.statusReason,
  linkStatus: connection.properties?.linkStatus,
  linkedConnectionId: connection.properties?.linkedConnectionId,
  approver: connection.properties?.approver,
  dateSubmitted: connection.properties?.dateSubmitted,
  provisioningState: connection.properties?.provisioningState,
  identity: toObservedIdentity(connection.identity),
  tags: userTags(connection.tags),
});

const optionalDiffers = (
  desired: string | undefined,
  previous: string | undefined,
) => (desired ?? "") !== (previous ?? "");

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "connectionName",
      "connectionId",
      "resourceGroup",
      "location",
      "pipeline",
      "direction",
      "dateSubmitted",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* adt
        .ListConnectionBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConnectionBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((connection) => {
        const group = resourceGroupOf(connection.id);
        return hasAnyAlchemyTag(connection.tags) &&
          group !== undefined &&
          connection.name !== undefined
          ? [toAttrs(group, connection.name, connection)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.connectionName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.pipeline, output.pipeline) ||
        (news.direction !== undefined &&
          !sameArm(news.direction, output.direction))
      ) {
        return { action: "replace" } as const;
      }
      // Request fields are not all echoed back; compare against the last
      // applied props.
      if (
        olds !== undefined &&
        (optionalDiffers(news.justification, olds.justification) ||
          optionalDiffers(news.requirementId, olds.requirementId) ||
          optionalDiffers(
            news.remoteSubscriptionId,
            olds.remoteSubscriptionId,
          ) ||
          optionalDiffers(news.pin, olds.pin) ||
          optionalDiffers(news.primaryContact, olds.primaryContact) ||
          !sameList(news.secondaryContacts, olds.secondaryContacts) ||
          !sameList(news.flowTypes, olds.flowTypes))
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
        output?.connectionName ??
        olds?.name ??
        (yield* createDataTransferName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        name,
      );
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
        output?.connectionName ??
        (yield* createDataTransferName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getConnection(subscriptionId, resourceGroup, name);
      const label = `data transfer connection ${name}`;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        connectionName: name,
      };

      // Observe.
      const existing = yield* get;

      // Ensure: the PUT is create-only; a concurrent create is a race.
      if (existing === undefined) {
        yield* adt
          .ConnectionsCreateOrUpdate({
            ...where,
            location,
            tags,
            identity: toIdentityInput(news.identity),
            properties: {
              pipeline: news.pipeline,
              direction: news.direction,
              justification: news.justification,
              requirementId: news.requirementId,
              remoteSubscriptionId: news.remoteSubscriptionId,
              pin: news.pin,
              primaryContact: news.primaryContact,
              secondaryContacts: news.secondaryContacts,
              flowTypes: news.flowTypes,
            },
          })
          .pipe(
            Effect.catchTag(
              "DataTransferConnectionAlreadyExists",
              () => Effect.void,
            ),
          );
      }
      let observed = yield* waitForProvisioned(
        label,
        get,
        (c) => c.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync tags and identity against the observed state.
      if (
        tagsDiffer(observed.tags, tags) ||
        identityDiffers(observed.identity, news.identity)
      ) {
        yield* adt.UpdateConnection({
          ...where,
          tags,
          identity: toIdentityInput(news.identity),
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (c) => c.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        adt.DeleteConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectionName: output.connectionName,
        }),
      );
      yield* waitUntilGone(
        `data transfer connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.connectionName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DataTransfer.Pipeline",
      ],
    },
  });
