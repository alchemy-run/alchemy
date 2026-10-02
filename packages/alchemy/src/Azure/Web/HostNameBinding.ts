import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
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
import { lower, siteWhere } from "./common.ts";

/** TLS binding mode of a custom hostname. */
export type HostNameSslState = "Disabled" | "SniEnabled" | "IpBasedEnabled";

export interface HostNameBindingProps {
  /** Resource group of the app. Changing it replaces the binding. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces the binding. */
  siteName: string;
  /**
   * Deployment slot of the app to bind on. Changing it replaces the binding.
   * @default the production slot
   */
  slot?: string;
  /**
   * Fully qualified custom hostname, e.g. `www.example.com`. The domain
   * needs a CNAME (or A record) to the app and an `asuid.{hostName}` TXT
   * record holding the app's `customDomainVerificationId`. Changing it
   * replaces the binding.
   */
  hostName: string;
  /**
   * TLS binding mode. `SniEnabled` and `IpBasedEnabled` need `thumbprint`
   * and a Basic or higher plan.
   * @default "Disabled"
   */
  sslState?: HostNameSslState;
  /** Thumbprint of the certificate (`Web.Certificate`) that serves TLS. */
  thumbprint?: string;
  /**
   * DNS record type that maps the hostname to the app.
   * @default "CName"
   */
  customHostNameDnsRecordType?: "CName" | "A";
}

export interface HostNameBinding extends Resource<
  "Azure.Web.HostNameBinding",
  HostNameBindingProps,
  {
    /** The bound hostname. */
    hostName: string;
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if the binding is slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** ARM resource ID of the binding. */
    hostNameBindingId: string;
    /** TLS binding mode. */
    sslState: string | undefined;
    /** Thumbprint of the bound certificate. */
    thumbprint: string | undefined;
    /** Virtual IP of an IP-based TLS binding. */
    virtualIp: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom hostname bound to an App Service app
 * (`Microsoft.Web/sites/hostNameBindings`).
 *
 * Azure verifies domain ownership when the binding is created, so the DNS
 * records must exist first: a CNAME to `{app}.azurewebsites.net` and a TXT
 * record `asuid.{hostName}` set to the app's `customDomainVerificationId`.
 *
 * @see https://learn.microsoft.com/azure/app-service/app-service-web-tutorial-custom-domain
 *
 * ### Binding a Custom Domain
 * **Example:** Hostname without TLS
 * ```typescript
 * const binding = yield* Azure.Web.HostNameBinding("www", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   hostName: "www.example.com",
 * });
 * ```
 *
 * ### TLS
 * **Example:** SNI binding with an App Service certificate
 * ```typescript
 * const binding = yield* Azure.Web.HostNameBinding("www", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   hostName: "www.example.com",
 *   sslState: "SniEnabled",
 *   thumbprint: certificate.thumbprint,
 * });
 * ```
 *
 * @resource
 */
export const HostNameBinding = Resource<HostNameBinding>(
  "Azure.Web.HostNameBinding",
);

const getBinding = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  hostName: string,
) => {
  const where = {
    ...siteWhere(subscriptionId, resourceGroup, siteName),
    hostName,
  };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppHostNameBinding(where)
      : web.GetWebAppHostNameBindingSlot({ ...where, slot }),
  );
};

export const HostNameBindingProvider = () =>
  Provider.succeed(HostNameBinding, {
    stables: [
      "hostName",
      "siteName",
      "slot",
      "resourceGroup",
      "hostNameBindingId",
    ],

    // Bindings are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot) ||
        lower(news.hostName) !== lower(output.hostName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      const hostName = output?.hostName ?? olds?.hostName;
      if (!resourceGroup || !siteName || !hostName) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* getBinding(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        hostName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, hostName, observed);
      // Bindings carry no tags; only a binding this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot, hostName } = news;
      const desired: web.HostNameBindingPropertiesInput = {
        siteName,
        customHostNameDnsRecordType:
          news.customHostNameDnsRecordType ?? "CName",
        hostNameType: "Verified",
        sslState: news.sslState ?? "Disabled",
        thumbprint: news.thumbprint,
      };
      const get = getBinding(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        hostName,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is a synchronous upsert that verifies DNS.
      if (
        observed === undefined ||
        (observed.properties?.sslState ?? "Disabled") !== desired.sslState ||
        lower(observed.properties?.thumbprint) !== lower(desired.thumbprint) ||
        (observed.properties?.customHostNameDnsRecordType ?? "CName") !==
          desired.customHostNameDnsRecordType
      ) {
        const where = {
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          hostName,
          properties: desired,
        };
        observed =
          slot === undefined
            ? yield* web.WebAppsCreateOrUpdateHostNameBinding(where)
            : yield* web.WebAppsCreateOrUpdateHostNameBindingSlot({
                ...where,
                slot,
              });
      }
      return toAttrs(resourceGroup, siteName, slot, hostName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
        hostName: output.hostName,
      };
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.DeleteWebAppHostNameBinding(where)
          : web.DeleteWebAppHostNameBindingSlot({
              ...where,
              slot: output.slot,
            }),
      );
      yield* waitUntilGone(
        `hostname binding ${output.hostName}`,
        getBinding(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
          output.hostName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  hostName: string,
  observed: web.GetWebAppHostNameBindingResponse,
) => ({
  hostName,
  siteName,
  slot,
  resourceGroup,
  hostNameBindingId: observed.id ?? "",
  sslState: observed.properties?.sslState,
  thumbprint: observed.properties?.thumbprint,
  virtualIp: observed.properties?.virtualIP,
});
