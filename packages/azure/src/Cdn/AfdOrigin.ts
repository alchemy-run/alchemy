import * as cdn from "@distilled.cloud/azure/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  AFD_DELETE_BUDGET,
  changedFields,
  createAfdName,
  profileOwnedByStack,
  ref,
  sameName,
  waitForAfd,
  whileOriginGroupInUse,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface AfdSharedPrivateLink {
  /**
   * ARM ID of the private-link target, e.g. `account.storageAccountId` or
   * a Web App's `siteId`.
   */
  privateLink: string;
  /** Region of the private-link target, e.g. `eastus`. */
  privateLinkLocation: string;
  /**
   * Sub-resource (group ID) of the target: `blob` or `web` for a storage
   * account, `sites` for App Service.
   */
  groupId?: string;
  /** Message shown to the target's owner with the connection request. */
  requestMessage?: string;
}

export interface AfdOriginProps {
  /** Resource group of the profile. Changing it replaces the origin. */
  resourceGroup: string;
  /** Front Door profile that holds the origin group. Changing it replaces the origin. */
  profile: string;
  /** Origin group the origin belongs to. Changing it replaces the origin. */
  originGroup: string;
  /**
   * Origin name: letters, digits, and hyphens, unique in the profile. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the origin.
   */
  name?: string;
  /**
   * Address of the origin: a domain name, IPv4, or IPv6 address, e.g. a
   * Web App's `defaultHostName`. Changing it updates the origin in place.
   */
  hostName: string;
  /**
   * Host header sent to the origin. Web Apps and Blob Storage need it to
   * match the origin host name.
   * @default `hostName`
   */
  originHostHeader?: string;
  /** HTTP port (1-65535). @default 80 */
  httpPort?: number;
  /** HTTPS port (1-65535). @default 443 */
  httpsPort?: number;
  /** Priority (1-5); lower priorities are preferred. @default 1 */
  priority?: number;
  /** Load-balancing weight (1-1000). @default 1000 */
  weight?: number;
  /** Whether the origin receives traffic. @default "Enabled" */
  enabledState?: "Enabled" | "Disabled";
  /** Validate the origin certificate's name. @default true */
  enforceCertificateNameCheck?: boolean;
  /**
   * How the origin certificate name is validated: against the origin's
   * `hostName`, against `customCertificateSubjects`, or against the
   * incoming request's host header. Applies when
   * `enforceCertificateNameCheck` is `true`.
   */
  certificateNameCheckValidationMode?:
    | "OriginHostname"
    | "CustomCertificateSubject"
    | "IncomingHostHeader";
  /** Allowed subjects (1-2) for `CustomCertificateSubject` validation. */
  customCertificateSubjects?: string[];
  /**
   * ARM ID of the Azure resource behind the origin (informational), e.g. a
   * Web App's `siteId`.
   * @default none
   */
  azureOrigin?: string;
  /**
   * Connect to the origin over Private Link (Premium only). The target's
   * owner must approve the connection request before traffic flows.
   * @default public connection
   */
  sharedPrivateLinkResource?: AfdSharedPrivateLink;
}

export interface AfdOrigin extends Resource<
  "Azure.Cdn.AfdOrigin",
  AfdOriginProps,
  {
    /** Name of the origin. */
    originName: string;
    /** ARM resource ID of the origin. */
    originId: string;
    /** Origin group that holds the origin. */
    originGroup: string;
    /** Front Door profile that holds the origin group. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Address of the origin. */
    hostName: string;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door origin (`Microsoft.Cdn/profiles/originGroups/origins`): a
 * backend that an origin group sends traffic to. It can be an App Service
 * Web App, a Container App, a Storage static website, any public host
 * name, or an IP address.
 *
 * Alchemy sends the origin's `hostName` as the `Host` header unless you
 * set `originHostHeader`, uses ports 80 and 443, and validates the
 * origin's certificate name. Origins carry no tags; Alchemy treats one as
 * owned when its profile carries this stack's ownership tags.
 *
 * :::caution[Changing `name`, `originGroup`, `profile`, or `resourceGroup` replaces the origin]
 * Alchemy creates the new origin and then deletes the old one. Changing
 * `hostName`, ports, priority, or weight updates the origin in place.
 * :::
 *
 * :::caution[The origin group must exist first]
 * Create the group with `Azure.Cdn.AfdOriginGroup` and pass
 * `origins.originGroupName`. A route on the group deploys only after the
 * group has an enabled origin.
 * :::
 *
 * @see https://learn.microsoft.com/azure/frontdoor/origin
 *
 * ### Creating an Origin
 * **Example:** Storage static website origin
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const origins = yield* Azure.Cdn.AfdOriginGroup("site", {
 *   profile: profile.profileName,
 * });
 * const origin = yield* Azure.Cdn.AfdOrigin("site", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "mysite.z13.web.core.windows.net",
 * });
 * ```
 *
 * **Example:** Public host with a fixed name
 * ```typescript
 * const origin = yield* Azure.Cdn.AfdOrigin("legacy", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   name: "legacy-api",
 *   hostName: "api.contoso.com",
 * });
 * ```
 *
 * ### Web App Origins
 * Use the app's `defaultHostName`. App Service routes by host header, so
 * keep `originHostHeader` at its default (the same host name).
 *
 * **Example:** App Service Web App behind Front Door
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", { main: "./src/api.ts" });
 * yield* Azure.Cdn.AfdOrigin("api", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: api.defaultHostName,
 *   azureOrigin: api.siteId,
 * });
 * ```
 *
 * ### Container App Origins
 * Use the app's ingress `fqdn`; the app needs external ingress.
 *
 * **Example:** Container App behind Front Door
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env");
 * const app = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   configuration: { ingress: { external: true, targetPort: 80 } },
 *   template: {
 *     containers: [{ name: "api", image: "mcr.microsoft.com/k8se/quickstart:latest" }],
 *   },
 * });
 * yield* Azure.Cdn.AfdOrigin("api", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: app.fqdn.as<string>(),
 * });
 * ```
 *
 * ### Host Header and Ports
 * Set `originHostHeader` when the origin serves several sites and picks
 * one by host name. Set `httpPort` and `httpsPort` (1-65535) when the
 * origin listens on other ports.
 *
 * **Example:** Shared host on custom ports
 * ```typescript
 * yield* Azure.Cdn.AfdOrigin("shop", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "203.0.113.10",
 *   originHostHeader: "shop.contoso.com",
 *   httpPort: 8080,
 *   httpsPort: 8443,
 * });
 * ```
 *
 * ### Priority and Weight
 * Front Door sends traffic to the healthy origins with the lowest
 * `priority` (1-5). Among those, `weight` (1-1000) sets each origin's
 * share.
 *
 * **Example:** Weighted secondary origin
 * ```typescript
 * const backup = yield* Azure.Cdn.AfdOrigin("backup", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "backup.example.com",
 *   priority: 2,
 *   weight: 500,
 * });
 * ```
 *
 * **Example:** Split traffic 90/10 between two origins
 * ```typescript
 * yield* Azure.Cdn.AfdOrigin("stable", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "stable.contoso.com",
 *   weight: 900,
 * });
 * yield* Azure.Cdn.AfdOrigin("canary", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "canary.contoso.com",
 *   weight: 100,
 * });
 * ```
 *
 * ### Draining an Origin
 * Set `enabledState: "Disabled"` to stop sending traffic to the origin
 * and keep it in the group.
 *
 * **Example:** Take an origin out of rotation
 * ```diff
 *  yield* Azure.Cdn.AfdOrigin("canary", {
 *    profile: profile.profileName,
 *    originGroup: origins.originGroupName,
 *    hostName: "canary.contoso.com",
 * +  enabledState: "Disabled",
 *  });
 * ```
 *
 * ### Certificate Validation
 * Front Door checks that the origin's certificate matches its host name.
 * Validate against fixed subjects when the certificate names another
 * host.
 *
 * **Example:** Accept a certificate issued for another name
 * ```typescript
 * yield* Azure.Cdn.AfdOrigin("internal", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "east.origin.contoso.com",
 *   certificateNameCheckValidationMode: "CustomCertificateSubject",
 *   customCertificateSubjects: ["origin.contoso.com"],
 * });
 * ```
 *
 * ### Private Link Origins
 * On a Premium profile, Front Door can reach the origin over Private Link
 * so the origin can turn off public access. Front Door creates a pending
 * connection request on the target; approve it on the target before
 * traffic flows.
 *
 * **Example:** Private storage static website
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("site");
 * const profile = yield* Azure.Cdn.Profile("cdn", { sku: "Premium_AzureFrontDoor" });
 * yield* Azure.Cdn.AfdOrigin("site", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "mysite.z13.web.core.windows.net",
 *   sharedPrivateLinkResource: {
 *     privateLink: account.storageAccountId,
 *     privateLinkLocation: "eastus",
 *     groupId: "web",
 *     requestMessage: "Front Door for contoso.com",
 *   },
 * });
 * ```
 *
 * ### Deleting an Origin
 * Front Door refuses to delete the last origin of a group while a route
 * still uses the group (`AfdLastOriginInUse`). When you remove both in one
 * deploy, Alchemy retries the origin delete for up to 10 minutes until the
 * route is gone.
 *
 * **Example:** Remove the route and its only origin together
 * ```diff
 * -yield* Azure.Cdn.AfdOrigin("api", {
 * -  profile: profile.profileName,
 * -  originGroup: origins.originGroupName,
 * -  hostName: api.defaultHostName,
 * -});
 * -yield* Azure.Cdn.Route("default", {
 * -  profile: profile.profileName,
 * -  endpoint: endpoint.endpointName,
 * -  originGroupId: origins.originGroupId,
 * -});
 * ```
 *
 * @resource
 */
export const AfdOrigin = GroupedResource<AfdOrigin>("Azure.Cdn.AfdOrigin");

const createOriginName = (id: string) => createAfdName(id, 50);

const getOrigin = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  originGroupName: string,
  originName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetAFDOrigin({
      subscriptionId,
      resourceGroupName,
      profileName,
      originGroupName,
      originName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  originGroup: string,
  name: string,
  origin: cdn.GetAFDOriginResponse,
): AfdOrigin["Attributes"] => ({
  originName: name,
  originId: origin.id ?? "",
  originGroup,
  profile,
  resourceGroup,
  hostName: origin.properties?.hostName ?? "",
  deploymentStatus: origin.properties?.deploymentStatus,
});

const desiredProperties = (news: AfdOriginProps) => ({
  hostName: news.hostName,
  originHostHeader: news.originHostHeader ?? news.hostName,
  httpPort: news.httpPort ?? 80,
  httpsPort: news.httpsPort ?? 443,
  priority: news.priority ?? 1,
  weight: news.weight ?? 1000,
  enabledState: news.enabledState ?? "Enabled",
  enforceCertificateNameCheck: news.enforceCertificateNameCheck ?? true,
  certificateNameCheckValidationMode: news.certificateNameCheckValidationMode,
  customCertificateSubjects: news.customCertificateSubjects,
  azureOrigin: ref(news.azureOrigin),
  sharedPrivateLinkResource:
    news.sharedPrivateLinkResource === undefined
      ? undefined
      : {
          ...news.sharedPrivateLinkResource,
          privateLink: { id: news.sharedPrivateLinkResource.privateLink },
        },
});

export const AfdOriginProvider = () =>
  Provider.succeed(AfdOrigin, {
    stables: ["originName", "originId", "originGroup", "profile", "resourceGroup"],

    // Origins are deleted with their origin group and profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        !sameName(news.originGroup, output.originGroup) ||
        (news.name !== undefined && !sameName(news.name, output.originName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      const originGroup = output?.originGroup ?? olds?.originGroup;
      if (resourceGroup === undefined || profile === undefined || originGroup === undefined) {
        return undefined;
      }
      const name = output?.originName ?? olds?.name ?? (yield* createOriginName(id));
      const observed = yield* getOrigin(subscriptionId, resourceGroup, profile, originGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, originGroup, name, observed);
      return (yield* profileOwnedByStack(subscriptionId, resourceGroup, profile))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile, originGroup } = news;
      const name = news.name ?? output?.originName ?? (yield* createOriginName(id));
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        originGroupName: originGroup,
        originName: name,
      };
      const get = getOrigin(subscriptionId, resourceGroup, profile, originGroup, name);
      const label = `Front Door origin ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn.CreateAFDOrigin({ ...where, properties }).pipe(Effect.retry(whileProfileBusy));
      }
      observed = yield* waitForAfd(label, get, (o) => o.properties?.provisioningState);

      // Sync mutable settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateAFDOrigin({ ...where, properties: changed })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(label, get, (o) => o.properties?.provisioningState);
      }

      return toAttrs(resourceGroup, profile, originGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteAFDOrigin({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            originGroupName: output.originGroup,
            originName: output.originName,
          })
          .pipe(Effect.retry(whileOriginGroupInUse)),
      );
      yield* waitUntilGone(
        `Front Door origin ${output.originName}`,
        getOrigin(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.originGroup,
          output.originName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
