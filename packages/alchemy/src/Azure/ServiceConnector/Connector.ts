import * as servicelinker from "@distilled.cloud/azure/servicelinker";
import * as Effect from "effect/Effect";
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
  type ConnectionProps,
  connectionPropsDiffer,
  observedDiffers,
  toLinkerInput,
} from "./ConnectionProperties.ts";
import { createLinkerName } from "./Linker.ts";

export interface ConnectorProps extends ConnectionProps {
  /** Resource group that holds the connector. Changing it replaces the connector. */
  resourceGroup: string;
  /**
   * Azure region of the connector. Changing it replaces the connector.
   * @default the provider's default location
   */
  location?: string;
  /**
   * Connector name: letters, digits, `.` and `_`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the connector.
   */
  name?: string;
}

export interface Connector extends Resource<
  "Azure.ServiceConnector.Connector",
  ConnectorProps,
  {
    /** Name of the connector. */
    connectorName: string;
    /** ARM resource ID of the connector. */
    connectorId: string;
    /** Resource group of the connector. */
    resourceGroup: string;
    /** Azure region of the connector. */
    location: string;
    /** Target service type. */
    targetType: string;
    /** ARM ID (or endpoint) of the target service. */
    target: string;
    /** Authentication type. */
    authType: string;
    /** Client library the configuration names target. */
    clientType: string;
    /** Provisioning state reported by Service Connector. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A regional Service Connector connector — a connection to a target
 * service that is not attached to an Azure compute resource, e.g. for an
 * app running locally or outside Azure.
 *
 * Service Connector validates the target, sets up the requested auth
 * (firewall rules, RBAC), and generates the configuration the client
 * needs; it applies no settings to a source. Use `Linker` to connect an
 * App Service site or Container App.
 *
 * Connectors cannot be tagged. The generated name encodes the app, stage,
 * logical ID, and instance ID, which is how Alchemy recognises its own
 * connectors; one with a custom name found without state is reported as
 * unowned.
 *
 * @see https://learn.microsoft.com/azure/service-connector/how-to-provide-correct-parameters
 *
 * ### Connecting to Storage
 * **Example:** Secret-based connection to a blob service
 * ```typescript
 * yield* Azure.ServiceConnector.Connector("local-storage", {
 *   resourceGroup: group.resourceGroupName,
 *   targetService: {
 *     type: "AzureResource",
 *     id: Output.interpolate`${account.storageAccountId}/blobServices/default`,
 *   },
 *   authInfo: { authType: "secret" },
 *   clientType: "nodejs",
 * });
 * ```
 *
 * ### Connecting with a User Account
 * **Example:** Grant a developer RBAC on the target
 * ```typescript
 * yield* Azure.ServiceConnector.Connector("dev-storage", {
 *   resourceGroup: group.resourceGroupName,
 *   targetService: { type: "AzureResource", id: blobServiceId },
 *   authInfo: { authType: "userAccount", principalId: developerObjectId },
 *   clientType: "python",
 * });
 * ```
 *
 * @resource
 */
export const Connector = Resource<Connector>(
  "Azure.ServiceConnector.Connector",
);

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  location: string,
  connectorName: string,
) =>
  orUndefinedIfNotFound(
    servicelinker.GetConnector({
      subscriptionId,
      resourceGroupName,
      location,
      connectorName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  location: string,
  name: string,
  connector: servicelinker.GetConnectorResponse,
): Connector["Attributes"] => ({
  connectorName: name,
  connectorId: connector.id ?? "",
  resourceGroup,
  location,
  targetType: connector.properties?.targetService?.type ?? "",
  target:
    connector.properties?.targetService?.id ??
    connector.properties?.targetService?.endpoint ??
    "",
  authType: connector.properties?.authInfo?.authType ?? "",
  clientType: connector.properties?.clientType ?? "none",
  provisioningState: connector.properties?.provisioningState,
});

const normalizeLocation = (location: string) =>
  location.replaceAll(" ", "").toLowerCase();

const sameId = (a: string, b: string) =>
  a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

export const ConnectorProvider = () =>
  Provider.succeed(Connector, {
    stables: ["connectorName", "connectorId", "resourceGroup", "location"],

    // Connectors live in a resource group; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined || !isResolved(news)) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location)) ||
        (news.name !== undefined && news.name !== output.connectorName) ||
        news.targetService.type !== output.targetType ||
        !sameId(
          news.targetService.type === "AzureResource"
            ? news.targetService.id
            : news.targetService.endpoint,
          output.target,
        )
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const location = output?.location ?? olds?.location ?? env.location;
      const generated = yield* createLinkerName(id, instanceId);
      const name = output?.connectorName ?? olds?.name ?? generated;
      const observed = yield* getConnector(
        env.subscriptionId,
        resourceGroup,
        location,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, location, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceLinker");
      const resourceGroup = news.resourceGroup;
      const location = news.location ?? output?.location ?? env.location;
      const name =
        news.name ??
        output?.connectorName ??
        (yield* createLinkerName(id, instanceId));
      const label = `service connector ${name}`;
      const get = getConnector(subscriptionId, resourceGroup, location, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is an upsert; GET does not echo secrets or
      // most options, so previous props are the baseline for those.
      if (
        observed === undefined ||
        observedDiffers(observed.properties, news) ||
        olds === undefined ||
        connectionPropsDiffer(olds, news)
      ) {
        yield* servicelinker.ConnectorCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          location,
          connectorName: name,
          properties: toLinkerInput(news),
        });
      }

      const fresh = yield* waitForProvisioned(
        label,
        get,
        (connector) => connector.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, location, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicelinker.DeleteConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          location: output.location,
          connectorName: output.connectorName,
        }),
      );
      yield* waitUntilGone(
        `service connector ${output.connectorName}`,
        getConnector(
          subscriptionId,
          output.resourceGroup,
          output.location,
          output.connectorName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
