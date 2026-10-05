import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { perimeterTags } from "./networkSecurityPerimeterShared.ts";

export interface NetworkSecurityPerimeterLoggingConfigurationProps {
  /** Resource group of the perimeter. Changing it replaces the perimeter logging configuration. */
  resourceGroup: string;
  /** Name of the parent network security perimeter. Changing it replaces the perimeter logging configuration. */
  networkSecurityPerimeter: string;
  /**
   * Name of the configuration. Azure allows only `instance`.
   * @default "instance"
   */
  name?: string;
  /**
   * Log categories to enable, e.g. `["NspPublicInboundPerimeterRulesAllowed",
   * "NspPublicInboundPerimeterRulesDenied"]`.
   */
  enabledLogCategories: string[];
}

export interface NetworkSecurityPerimeterLoggingConfiguration extends Resource<
  "Azure.Network.NetworkSecurityPerimeterLoggingConfiguration",
  NetworkSecurityPerimeterLoggingConfigurationProps,
  {
    /** Name of the perimeter logging configuration. */
    loggingConfigurationName: string;
    /** ARM resource ID of the perimeter logging configuration. */
    loggingConfigurationId: string;
    /** Name of the parent network security perimeter. */
    networkSecurityPerimeter: string;
    /** Resource group of the perimeter. */
    resourceGroup: string;
    /** Enabled log categories. */
    enabledLogCategories: string[];
  },
  never,
  Providers
> {}

/**
 * The access-log configuration of an Azure network security perimeter —
 * which log categories the perimeter emits (route them to a destination
 * with a diagnostic setting). The configuration is a singleton named
 * `instance`. It carries no tags: ownership follows the perimeter.
 *
 * @see https://learn.microsoft.com/azure/private-link/network-security-perimeter-diagnostic-logs
 *
 * ### Enabling Logs
 * **Example:** Log denied inbound traffic
 * ```typescript
 * yield* Azure.Network.NetworkSecurityPerimeterLoggingConfiguration("logs", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
 *   enabledLogCategories: ["NspPublicInboundPerimeterRulesDenied"],
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityPerimeterLoggingConfiguration =
  Resource<NetworkSecurityPerimeterLoggingConfiguration>(
    "Azure.Network.NetworkSecurityPerimeterLoggingConfiguration",
  );

export const NetworkSecurityPerimeterLoggingConfigurationProvider = () =>
  Provider.succeed(
    NetworkSecurityPerimeterLoggingConfiguration,
    networkProvider<NetworkSecurityPerimeterLoggingConfiguration>()({
      label: "perimeter logging configuration",
      nameAttr: "loggingConfigurationName",
      parents: ["networkSecurityPerimeter"],
      tracked: false,
      physicalName: () => Effect.succeed("instance"),
      // Without the EnableServiceTagsInNsp flag every call on the child
      // answers `SubscriptionFeatureNotRegistered`: such a subscription can
      // never hold one (the PUT is rejected the same way), so it is absent
      // and deleting it is a no-op (the perimeter delete removes children).
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkSecurityPerimeterLoggingConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.networkSecurityPerimeter!,
            loggingConfigurationName: path.name,
          }),
        ).pipe(
          Effect.catchTag("SubscriptionFeatureNotRegistered", () =>
            Effect.succeed(undefined),
          ),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkSecurityPerimeterLoggingConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          loggingConfigurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network
          .DeleteNetworkSecurityPerimeterLoggingConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.networkSecurityPerimeter!,
            loggingConfigurationName: path.name,
          })
          .pipe(
            Effect.catchTag("SubscriptionFeatureNotRegistered", () =>
              Effect.void,
            ),
          ),
      ownerTags: perimeterTags,
      body: (news) => ({
        properties: { enabledLogCategories: news.enabledLogCategories },
      }),
      drifted: (observed, _body, news) =>
        !sameSet(
          observed.properties?.enabledLogCategories,
          news.enabledLogCategories,
        ),
      toAttrs: (path, observed) => ({
        loggingConfigurationName: path.name,
        loggingConfigurationId: observed.id ?? "",
        networkSecurityPerimeter: path.networkSecurityPerimeter!,
        resourceGroup: path.resourceGroup,
        enabledLogCategories: [
          ...(observed.properties?.enabledLogCategories ?? []),
        ],
      }),
      dependsOn: ["Azure.Network.NetworkSecurityPerimeter"],
    }),
  );
