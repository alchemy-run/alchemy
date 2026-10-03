import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower, ref, sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface SecurityPartnerProviderProps {
  /** Resource group of the provider. Changing it replaces the provider. */
  resourceGroup: string;
  /**
   * Name of the provider: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the provider.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the provider.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Partner security-as-a-service offering. Changing it replaces the
   * provider.
   */
  securityProviderName: "ZScaler" | "IBoss" | "Checkpoint";
  /** ARM ID of the secured virtual hub the partner protects. */
  virtualHubId?: string;
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SecurityPartnerProvider extends Resource<
  "Azure.Network.SecurityPartnerProvider",
  SecurityPartnerProviderProps,
  {
    /** Name of the provider. */
    securityPartnerProviderName: string;
    /** ARM resource ID of the provider. */
    securityPartnerProviderId: string;
    /** Resource group of the provider. */
    resourceGroup: string;
    /** Location of the provider. */
    location: string;
    /** Partner offering. */
    securityProviderName: string | undefined;
    /** ARM ID of the secured virtual hub. */
    virtualHubId: string | undefined;
    /**
     * Connection state with the partner (`Unknown`, `PartiallyConnected`,
     * `Connected`, `NotConnected`). The partner side is configured in the
     * partner's portal.
     */
    connectionStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure security partner provider — connects a secured Virtual WAN hub
 * to a third-party security-as-a-service partner (Zscaler, iboss, Check
 * Point) so branch and user internet traffic is filtered by the partner.
 * The partner side (tenant, tunnels) is completed in the partner's portal.
 *
 * @see https://learn.microsoft.com/azure/firewall-manager/trusted-security-partners
 *
 * ### Connecting a Partner
 * **Example:** Zscaler on a secured hub
 * ```typescript
 * const partner = yield* Azure.Network.SecurityPartnerProvider("zscaler", {
 *   resourceGroup: group.resourceGroupName,
 *   securityProviderName: "ZScaler",
 *   virtualHubId: hub.virtualHubId,
 * });
 * ```
 *
 * @resource
 */
export const SecurityPartnerProvider = Resource<SecurityPartnerProvider>(
  "Azure.Network.SecurityPartnerProvider",
);

export const SecurityPartnerProviderProvider = () =>
  Provider.succeed(
    SecurityPartnerProvider,
    networkProvider<SecurityPartnerProvider>()({
      label: "security partner provider",
      nameAttr: "securityPartnerProviderName",
      tracked: true,
      immutable: (news, output) =>
        lower(news.securityProviderName) !== lower(output.securityProviderName),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetSecurityPartnerProvider({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            securityPartnerProviderName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.SecurityPartnerProvidersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          securityPartnerProviderName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteSecurityPartnerProvider({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          securityPartnerProviderName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateSecurityPartnerProviderTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          securityPartnerProviderName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListSecurityPartnerProviders({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          securityProviderName: news.securityProviderName,
          virtualHub: ref(news.virtualHubId),
        },
      }),
      drifted: (observed, _body, news) =>
        news.virtualHubId !== undefined &&
        !sameId(observed.properties?.virtualHub?.id, news.virtualHubId),
      toAttrs: (path, observed) => ({
        securityPartnerProviderName: path.name,
        securityPartnerProviderId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        securityProviderName: observed.properties?.securityProviderName,
        virtualHubId: observed.properties?.virtualHub?.id,
        connectionStatus: observed.properties?.connectionStatus,
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
