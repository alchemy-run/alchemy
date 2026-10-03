import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  instanceOwnedByStage,
  type ManagedIdentityReference,
  sameIdentityReference,
  secretValue,
} from "./Common.ts";

export type EndpointType = "EventHub" | "EventGrid" | "ServiceBus";

export interface EndpointProps {
  /** Resource group of the instance. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Digital Twins instance the endpoint belongs to. Changing it replaces the endpoint. */
  instance: string;
  /**
   * Endpoint name: 2-49 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the endpoint.
   */
  name?: string;
  /** Kind of egress target. Changing it replaces the endpoint. */
  endpointType: EndpointType;
  /**
   * How the instance authenticates to the target. `KeyBased` needs a
   * connection string (Event Hubs / Service Bus) or access key (Event
   * Grid); `IdentityBased` (Event Hubs / Service Bus only) needs
   * `endpointUri`, `entityPath`, and a role assignment for the identity.
   * @default "KeyBased"
   */
  authenticationType?: "KeyBased" | "IdentityBased";
  /**
   * Managed identity for `IdentityBased` authentication.
   * @default the instance's system-assigned identity
   */
  identity?: ManagedIdentityReference;
  /**
   * Event Hubs / Service Bus (`IdentityBased`): namespace URL, e.g.
   * `sb://{namespace}.servicebus.windows.net`.
   */
  endpointUri?: string;
  /** Event Hubs / Service Bus (`IdentityBased`): event hub, queue, or topic name. */
  entityPath?: string;
  /**
   * Event Hubs / Service Bus (`KeyBased`): primary connection string,
   * including `EntityPath`.
   */
  primaryConnectionString?: string | Redacted.Redacted<string>;
  /** Event Hubs / Service Bus (`KeyBased`): secondary connection string. */
  secondaryConnectionString?: string | Redacted.Redacted<string>;
  /** Event Grid: topic endpoint URL, e.g. `https://{topic}.{region}-1.eventgrid.azure.net/api/events`. */
  topicEndpoint?: string;
  /** Event Grid: primary access key of the topic. */
  accessKey1?: string | Redacted.Redacted<string>;
  /** Event Grid: secondary access key of the topic. */
  accessKey2?: string | Redacted.Redacted<string>;
  /** Dead-letter storage container URL for `IdentityBased` authentication. */
  deadLetterUri?: string;
  /** Dead-letter storage container SAS URL for `KeyBased` authentication. */
  deadLetterSecret?: string | Redacted.Redacted<string>;
}

export interface Endpoint extends Resource<
  "Azure.DigitalTwins.Endpoint",
  EndpointProps,
  {
    /** Name of the endpoint. */
    endpointName: string;
    /** Instance the endpoint belongs to. */
    instance: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the endpoint. */
    endpointId: string;
    /** Kind of egress target. */
    endpointType: string;
    /** Authentication type. */
    authenticationType: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Time the endpoint was added to the instance. */
    createdTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An egress endpoint of an Azure Digital Twins instance — an Event Hub,
 * Event Grid topic, or Service Bus topic that event routes deliver twin
 * change and telemetry events to.
 *
 * Endpoints have no tags; Alchemy treats an endpoint as owned when its
 * instance carries this stack's ownership tags. Secrets (connection
 * strings, access keys) are write-only: Azure obfuscates them on read, so
 * changing one re-sends the endpoint.
 *
 * @see https://learn.microsoft.com/azure/digital-twins/concepts-route-events
 *
 * ### Event Grid Endpoints
 * **Example:** Key-based Event Grid topic endpoint
 * ```typescript
 * const topic = yield* Azure.EventGrid.Topic("twin-events", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.DigitalTwins.Endpoint("events", {
 *   resourceGroup: group.resourceGroupName,
 *   instance: twins.instanceName,
 *   endpointType: "EventGrid",
 *   topicEndpoint: topic.endpoint,
 *   accessKey1: topic.primaryKey,
 * });
 * ```
 *
 * ### Event Hubs Endpoints
 * **Example:** Identity-based Event Hub endpoint
 * ```typescript
 * const twins = yield* Azure.DigitalTwins.Instance("factory", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("twins-sends-events", {
 *   scope: hub.eventHubId,
 *   // Azure Event Hubs Data Sender
 *   roleDefinitionId: "2b629674-e913-4c01-ae53-ef4638d8f975",
 *   principalId: twins.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const endpoint = yield* Azure.DigitalTwins.Endpoint("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   instance: twins.instanceName,
 *   endpointType: "EventHub",
 *   authenticationType: "IdentityBased",
 *   endpointUri: `sb://${namespace.namespaceName}.servicebus.windows.net`,
 *   entityPath: hub.eventHubName,
 * });
 * ```
 *
 * @resource
 */
export const Endpoint = Resource<Endpoint>("Azure.DigitalTwins.Endpoint");

type ObservedEndpoint = digitaltwins.GetDigitalTwinsEndpointResponse;

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  endpointName: string,
) =>
  orUndefinedIfNotFound(
    digitaltwins.GetDigitalTwinsEndpoint({
      subscriptionId,
      resourceGroupName,
      resourceName,
      endpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  instance: string,
  name: string,
  observed: ObservedEndpoint,
): Endpoint["Attributes"] => ({
  endpointName: name,
  instance,
  resourceGroup,
  endpointId: observed.id ?? "",
  endpointType: observed.properties.endpointType,
  authenticationType: observed.properties.authenticationType ?? "KeyBased",
  provisioningState: observed.properties.provisioningState ?? undefined,
  createdTime: observed.properties.createdTime ?? undefined,
});

/** The full PUT body for the endpoint (secrets unwrapped). */
const desiredProperties = (
  news: EndpointProps,
): digitaltwins.DigitalTwinsEndpointResourcePropertiesInput => {
  const authenticationType = news.authenticationType ?? "KeyBased";
  const identityBased = authenticationType === "IdentityBased";
  const base = {
    endpointType: news.endpointType,
    authenticationType,
    deadLetterUri: news.deadLetterUri,
    deadLetterSecret: secretValue(news.deadLetterSecret),
    identity: identityBased
      ? (news.identity ?? { type: "SystemAssigned" })
      : undefined,
  };
  switch (news.endpointType) {
    case "EventGrid":
      return {
        ...base,
        TopicEndpoint: news.topicEndpoint,
        accessKey1: secretValue(news.accessKey1),
        accessKey2: secretValue(news.accessKey2),
      };
    case "EventHub":
      return {
        ...base,
        endpointUri: news.endpointUri,
        entityPath: news.entityPath,
        connectionStringPrimaryKey: secretValue(news.primaryConnectionString),
        connectionStringSecondaryKey: secretValue(
          news.secondaryConnectionString,
        ),
      };
    case "ServiceBus":
      return {
        ...base,
        endpointUri: news.endpointUri,
        entityPath: news.entityPath,
        primaryConnectionString: secretValue(news.primaryConnectionString),
        secondaryConnectionString: secretValue(news.secondaryConnectionString),
      };
  }
};

const norm = (value: string | null | undefined) =>
  (value ?? "").replace(/\/+$/, "").toLowerCase();

/** Whether the observed non-secret configuration matches the desired one. */
const observedMatches = (
  observed: ObservedEndpoint,
  desired: digitaltwins.DigitalTwinsEndpointResourcePropertiesInput,
) => {
  const p = observed.properties;
  return (
    (p.authenticationType ?? "KeyBased") === desired.authenticationType &&
    norm(p.endpointUri) === norm(desired.endpointUri) &&
    (p.entityPath ?? "") === (desired.entityPath ?? "") &&
    norm(p.TopicEndpoint) === norm(desired.TopicEndpoint) &&
    norm(p.deadLetterUri) === norm(desired.deadLetterUri) &&
    sameIdentityReference(
      p.identity,
      desired.identity
        ? {
            type: desired.identity.type as ManagedIdentityReference["type"],
            userAssignedIdentity:
              desired.identity.userAssignedIdentity ?? undefined,
          }
        : undefined,
    )
  );
};

const secretsOf = (props: EndpointProps | undefined) =>
  props === undefined
    ? undefined
    : [
        props.primaryConnectionString,
        props.secondaryConnectionString,
        props.accessKey1,
        props.accessKey2,
        props.deadLetterSecret,
      ].map(secretValue);

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: ["endpointName", "instance", "resourceGroup", "endpointId"],

    // Endpoints live inside an instance; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.instance.toLowerCase() !== output.instance.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.endpointName.toLowerCase()) ||
        news.endpointType !== output.endpointType
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const instance = output?.instance ?? olds?.instance;
      if (resourceGroup === undefined || instance === undefined) {
        return undefined;
      }
      const name =
        output?.endpointName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        instance,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, instance, name, observed);
      return (yield* instanceOwnedByStage(
        subscriptionId,
        resourceGroup,
        instance,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DigitalTwins");
      const { resourceGroup, instance } = news;
      const name =
        news.name ?? output?.endpointName ?? (yield* createChildName(id));
      const get = getEndpoint(subscriptionId, resourceGroup, instance, name);
      const settle = waitForProvisioned(
        `digital twins endpoint ${name}`,
        get,
        (endpoint) => endpoint.properties.provisioningState ?? undefined,
        { interval: "5 seconds", times: 60 },
      );
      const properties = desiredProperties(news);

      // Observe.
      let observed = yield* get;
      if (observed?.properties.provisioningState === "Deleting") {
        yield* waitUntilGone(`digital twins endpoint ${name}`, get, {
          interval: "5 seconds",
          times: 60,
        });
        observed = undefined;
      } else if (
        observed !== undefined &&
        observed.properties.provisioningState !== "Succeeded"
      ) {
        observed = yield* settle;
      }

      // Ensure + sync: the PUT replaces the whole endpoint. Secrets are
      // obfuscated on read, so a secret change is detected against the
      // previous props (and always re-sent on adoption).
      const secretsChanged =
        JSON.stringify(secretsOf(olds)) !== JSON.stringify(secretsOf(news));
      if (
        observed === undefined ||
        !observedMatches(observed, properties) ||
        secretsChanged
      ) {
        yield* digitaltwins.DigitalTwinsEndpointCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: instance,
          endpointName: name,
          properties,
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, instance, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        digitaltwins.DeleteDigitalTwinsEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.instance,
          endpointName: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `digital twins endpoint ${output.endpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.instance,
          output.endpointName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
