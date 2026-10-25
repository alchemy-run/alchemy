import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { subsetMatches } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export type PortalCspMode = apim.PortalConfigCspPropertiesMode;

export interface PortalConfigProps {
  /**
   * Resource group of the API Management service.
   * Changing it replaces the portal configuration.
   */
  resourceGroup: string;
  /**
   * API Management service whose developer portal is configured.
   * Changing it replaces the portal configuration.
   */
  serviceName: string;
  /**
   * Allow visitors to sign in with a user name and password.
   * @default true
   */
  enableBasicAuth?: boolean;
  /**
   * Sign-in settings.
   * @default not set (Azure's default applies)
   */
  signin?: {
    /**
     * Redirect anonymous visitors to the sign-in page.
     * @default false
     */
    require?: boolean;
  };
  /**
   * Sign-up settings.
   * @default not set (Azure's default applies)
   */
  signup?: {
    /** Terms of service shown on the sign-up page. */
    termsOfService?: {
      /** Terms of service text. */
      text?: string;
      /**
       * Ask visitors to accept the terms of service.
       * @default false
       */
      requireConsent?: boolean;
    };
  };
  /**
   * Delegation of sign-up and product subscriptions to your own website.
   * @default not set (Azure's default applies)
   */
  delegation?: {
    /**
     * Delegate user registration.
     * @default false
     */
    delegateRegistration?: boolean;
    /**
     * Delegate product subscriptions.
     * @default false
     */
    delegateSubscription?: boolean;
    /** Delegation endpoint URL. */
    delegationUrl?: string;
    /**
     * Base64-encoded key that proves delegated requests come from API
     * Management.
     */
    validationKey?: Redacted.Redacted<string>;
  };
  /**
   * Cross-Origin Resource Sharing (CORS) settings of the portal.
   * @default not set (Azure's default applies)
   */
  cors?: {
    /** Allowed origins, e.g. `https://trusted.com`. */
    allowedOrigins?: string[];
  };
  /**
   * Content Security Policy (CSP) settings of the portal.
   * @default not set (Azure's default applies)
   */
  csp?: {
    /**
     * CSP mode.
     * @default "disabled"
     */
    mode?: PortalCspMode;
    /** URLs that receive CSP violation reports. */
    reportUri?: string[];
    /** Allowed sources, e.g. `*.trusted.com`, `https://`. */
    allowedSources?: string[];
  };
}

export interface PortalConfig extends Resource<
  "Azure.ApiManagement.PortalConfig",
  PortalConfigProps,
  {
    /** Portal configuration identifier (always `default`). */
    portalConfigName: string;
    /** ARM resource ID of the portal configuration. */
    portalConfigId: string;
    /** API Management service whose portal is configured. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Whether user name and password sign-in is enabled. */
    enableBasicAuth: boolean;
  },
  never,
  Providers
> {}

/**
 * The developer portal configuration of an API Management service
 * (`Microsoft.ApiManagement/service/portalconfigs`): sign-in and sign-up
 * behavior, delegation, CORS, and Content Security Policy. Every service
 * with a developer portal has exactly one configuration (`default`);
 * deleting the resource restores the default settings. Not available on
 * the Consumption tier.
 *
 * :::caution
 * Changing `serviceName` or `resourceGroup` replaces the portal
 * configuration.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/portal-config
 *
 * ### Configuring the Developer Portal
 * **Example:** Require sign-in and allow one CORS origin
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * yield* Azure.ApiManagement.PortalConfig("portal", {
 *   serviceName: apim.serviceName,
 *   signin: { require: true },
 *   cors: { allowedOrigins: ["https://example.com"] },
 * });
 * ```
 *
 * @resource
 */
export const PortalConfig = GroupedResource<PortalConfig>("Azure.ApiManagement.PortalConfig");

interface Key {
  resourceGroup: string;
  serviceName: string;
  portalConfigName: string;
}

/** Settings of a portal nobody configured. */
const defaults: apim.PortalConfigProperties = {
  enableBasicAuth: true,
  signin: { require: false },
  signup: { termsOfService: { requireConsent: false } },
  delegation: { delegateRegistration: false, delegateSubscription: false },
  cors: { allowedOrigins: [] },
  csp: { mode: "disabled", reportUri: [], allowedSources: [] },
};

/** Desired properties: unset fields keep Azure's defaults. */
const desiredProperties = (news: PortalConfigProps): apim.PortalConfigProperties => ({
  enableBasicAuth: news.enableBasicAuth ?? true,
  signin: { ...defaults.signin, ...news.signin },
  signup: {
    termsOfService: { ...defaults.signup?.termsOfService, ...news.signup?.termsOfService },
  },
  delegation: {
    ...defaults.delegation,
    ...news.delegation,
    validationKey: reveal(news.delegation?.validationKey),
  },
  cors: { ...defaults.cors, ...news.cors },
  csp: { ...defaults.csp, ...news.csp },
});

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  portalConfigId: key.portalConfigName,
});

export const PortalConfigProvider = () =>
  Provider.succeed(PortalConfig, {
    stables: ["portalConfigName", "portalConfigId", "serviceName", "resourceGroup"],
    // The configuration always exists; nuke has nothing to delete.
    nuke: { singleton: true },
    ...entityLifecycle<
      PortalConfigProps,
      PortalConfig["Attributes"],
      Key,
      apim.GetPortalConfigResponse
    >({
      label: (key) => `API Management portal configuration of ${key.serviceName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          portalConfigName: "default",
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) => apim.GetPortalConfig(where(subscriptionId, key)),
      put: (subscriptionId, key, news) =>
        apim.PortalConfigCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: desiredProperties(news),
        }),
      // The configuration cannot be deleted; restore the defaults instead.
      remove: (subscriptionId, key) =>
        apim.PortalConfigCreateOrUpdate({ ...where(subscriptionId, key), properties: defaults }),
      resetOnDelete: true,
      // GET does not return the validation key; compare it against the last props.
      inSync: (news, observed, olds) => {
        const desired = desiredProperties(news);
        return (
          subsetMatches(
            { ...desired, delegation: { ...desired.delegation, validationKey: undefined } },
            observed.properties,
          ) && reveal(news.delegation?.validationKey) === reveal(olds?.delegation?.validationKey)
        );
      },
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        portalConfigName: key.portalConfigName,
        portalConfigId: observed.id ?? "",
        enableBasicAuth: observed.properties?.enableBasicAuth ?? true,
      }),
    }),
  });
