import * as web from "@distilled.cloud/azure/web";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, reveal, siteWhere } from "./common.ts";

export interface HybridConnectionProps {
  /** Resource group of the app. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Name of the Azure Relay namespace. Changing it replaces the connection.
   */
  namespaceName: string;
  /**
   * Name of the hybrid connection in the Relay namespace. Changing it
   * replaces the connection.
   */
  relayName: string;
  /** ARM ID of the Relay hybrid connection. */
  relayArmUri: string;
  /** On-premises host name the app reaches through the connection. */
  hostname: string;
  /** On-premises port the app reaches through the connection. */
  port: number;
  /**
   * Name of the Relay authorization rule with `Send` rights.
   * @default "defaultSender"
   */
  sendKeyName?: string;
  /** Primary key of the `sendKeyName` authorization rule. */
  sendKeyValue: string | Redacted.Redacted<string>;
  /**
   * DNS suffix of the Service Bus endpoint.
   * @default ".servicebus.windows.net"
   */
  serviceBusSuffix?: string;
}

export interface HybridConnection extends Resource<
  "Azure.Web.HybridConnection",
  HybridConnectionProps,
  {
    /** ARM resource ID of the connection on the app. */
    hybridConnectionId: string;
    /** Name of the app. */
    siteName: string;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Name of the Relay namespace. */
    namespaceName: string;
    /** Name of the Relay hybrid connection. */
    relayName: string;
    /** ARM ID of the Relay hybrid connection. */
    relayArmUri: string | undefined;
    /** On-premises host name. */
    hostname: string | undefined;
    /** On-premises port. */
    port: number | undefined;
    /** Name of the Relay authorization rule used to send. */
    sendKeyName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An App Service Hybrid Connection
 * (`Microsoft.Web/sites/hybridConnectionNamespaces/relays`) that lets an app
 * reach an on-premises `host:port` through an Azure Relay hybrid connection
 * and the Hybrid Connection Manager agent. Requires a Basic or higher plan.
 *
 * @see https://learn.microsoft.com/azure/app-service/app-service-hybrid-connections
 *
 * ### Connecting to an On-Premises Endpoint
 * **Example:** SQL Server behind the corporate firewall
 * ```typescript
 * yield* Azure.Web.HybridConnection("onprem-sql", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   namespaceName: "contoso-relay",
 *   relayName: "onprem-sql",
 *   relayArmUri: hybridConnectionId,
 *   hostname: "sql01.corp.contoso.com",
 *   port: 1433,
 *   sendKeyName: "defaultSender",
 *   sendKeyValue: Redacted.make(senderKey),
 * });
 * ```
 *
 * @resource
 */
export const HybridConnection = Resource<HybridConnection>(
  "Azure.Web.HybridConnection",
);

type ObservedConnection = web.GetWebAppHybridConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  namespaceName: string,
  relayName: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebAppHybridConnection({
      ...siteWhere(subscriptionId, resourceGroup, siteName),
      namespaceName,
      relayName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  namespaceName: string,
  relayName: string,
  observed: ObservedConnection,
): HybridConnection["Attributes"] => ({
  hybridConnectionId: observed.id ?? "",
  siteName,
  resourceGroup,
  namespaceName,
  relayName,
  relayArmUri: observed.properties?.relayArmUri,
  hostname: observed.properties?.hostname,
  port: observed.properties?.port,
  sendKeyName: observed.properties?.sendKeyName,
});

export const HybridConnectionProvider = () =>
  Provider.succeed(HybridConnection, {
    stables: [
      "hybridConnectionId",
      "siteName",
      "resourceGroup",
      "namespaceName",
      "relayName",
    ],

    // Hybrid connections are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.namespaceName) !== lower(output.namespaceName) ||
        lower(news.relayName) !== lower(output.relayName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      const namespaceName = output?.namespaceName ?? olds?.namespaceName;
      const relayName = output?.relayName ?? olds?.relayName;
      if (
        resourceGroup === undefined ||
        siteName === undefined ||
        namespaceName === undefined ||
        relayName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        siteName,
        namespaceName,
        relayName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        siteName,
        namespaceName,
        relayName,
        observed,
      );
      // Hybrid connections carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, namespaceName, relayName } = news;
      const sendKeyValue = reveal(news.sendKeyValue);
      const desired = {
        serviceBusNamespace: namespaceName,
        relayName,
        relayArmUri: news.relayArmUri,
        hostname: news.hostname,
        port: news.port,
        sendKeyName: news.sendKeyName ?? "defaultSender",
        sendKeyValue,
        serviceBusSuffix: news.serviceBusSuffix ?? ".servicebus.windows.net",
      };

      // Observe.
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        siteName,
        namespaceName,
        relayName,
      );

      // Ensure + sync (one synchronous PUT). The send key is write-only, so
      // it is re-sent only when the desired secret changes.
      const drifted =
        observed === undefined ||
        lower(observed.properties?.relayArmUri) !==
          lower(desired.relayArmUri) ||
        lower(observed.properties?.hostname) !== lower(desired.hostname) ||
        observed.properties?.port !== desired.port ||
        observed.properties?.sendKeyName !== desired.sendKeyName ||
        sendKeyValue !== reveal(olds?.sendKeyValue);
      const result = drifted
        ? yield* web.WebAppsCreateOrUpdateHybridConnection({
            ...siteWhere(subscriptionId, resourceGroup, siteName),
            namespaceName,
            relayName,
            properties: desired,
          })
        : observed;
      return toAttrs(resourceGroup, siteName, namespaceName, relayName, result);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppHybridConnection({
          ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
          namespaceName: output.namespaceName,
          relayName: output.relayName,
        }),
      );
      yield* waitUntilGone(
        `hybrid connection ${output.relayName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.namespaceName,
          output.relayName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
      ],
    },
  });
