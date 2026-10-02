import * as web from "@distilled.cloud/azure/web";
import * as Data from "effect/Data";
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
import { lower } from "./common.ts";

/** How Azure validates ownership of a static site's custom domain. */
export type StaticSiteDomainValidationMethod =
  | "cname-delegation"
  | "dns-txt-token";

export interface StaticSiteCustomDomainProps {
  /**
   * Resource group of the static site. Changing it replaces the domain.
   */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the domain. */
  staticSiteName: string;
  /**
   * Custom domain, e.g. `www.example.com`. Changing it replaces the domain.
   */
  domainName: string;
  /**
   * Validation method. `cname-delegation` requires a CNAME record from the
   * domain to the site's default host name before deploying;
   * `dns-txt-token` returns a `validationToken` to publish as a TXT record
   * at `_dnsauth.{domain}` (required for apex domains). Changing it
   * replaces the domain.
   * @default "cname-delegation"
   */
  validationMethod?: StaticSiteDomainValidationMethod;
}

export interface StaticSiteCustomDomain extends Resource<
  "Azure.Web.StaticSiteCustomDomain",
  StaticSiteCustomDomainProps,
  {
    /** The custom domain. */
    domainName: string;
    /** Name of the static site. */
    staticSiteName: string;
    /** Resource group of the static site. */
    resourceGroup: string;
    /** ARM resource ID of the custom domain. */
    customDomainId: string;
    /** Validation method. */
    validationMethod: StaticSiteDomainValidationMethod;
    /**
     * Status, e.g. `Ready`, or `Validating` while a `dns-txt-token` domain
     * waits for its TXT record.
     */
    status: string | undefined;
    /**
     * Token to publish as a TXT record at `_dnsauth.{domain}` (for
     * `dns-txt-token` validation).
     */
    validationToken: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom domain attached to an Azure Static Web App.
 *
 * With `cname-delegation`, create the CNAME record to the site's
 * `defaultHostname` first; the deploy waits until Azure validates it. With
 * `dns-txt-token`, the deploy returns as soon as Azure issues the
 * `validationToken`; publish it as a TXT record at `_dnsauth.{domain}` and
 * Azure finishes validation in the background.
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/custom-domain
 *
 * ### Adding a Custom Domain
 * **Example:** Subdomain validated by CNAME
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Web.StaticSiteCustomDomain("www", {
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   domainName: "www.example.com",
 * });
 * ```
 *
 * **Example:** Apex domain validated by TXT token
 * ```typescript
 * const domain = yield* Azure.Web.StaticSiteCustomDomain("apex", {
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   domainName: "example.com",
 *   validationMethod: "dns-txt-token",
 * });
 * // publish domain.validationToken as TXT _dnsauth.example.com
 * ```
 *
 * @resource
 */
export const StaticSiteCustomDomain = Resource<StaticSiteCustomDomain>(
  "Azure.Web.StaticSiteCustomDomain",
);

export class CustomDomainValidationFailed extends Data.TaggedError(
  "Azure.Web.CustomDomainValidationFailed",
)<{
  readonly domainName: string;
  readonly message: string;
}> {}

type ObservedDomain = web.GetStaticSiteStaticSiteCustomDomainResponse;

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  domainName: string,
) =>
  orUndefinedIfNotFound(
    web.GetStaticSiteStaticSiteCustomDomain({
      subscriptionId,
      resourceGroupName,
      name,
      domainName,
    }),
  );

const toAttrs = (
  props: {
    resourceGroup: string;
    staticSiteName: string;
    domainName: string;
    validationMethod: StaticSiteDomainValidationMethod;
  },
  domain: ObservedDomain,
): StaticSiteCustomDomain["Attributes"] => ({
  domainName: props.domainName,
  staticSiteName: props.staticSiteName,
  resourceGroup: props.resourceGroup,
  customDomainId: domain.id ?? "",
  validationMethod: props.validationMethod,
  status: domain.properties?.status,
  validationToken: domain.properties?.validationToken,
});

export const StaticSiteCustomDomainProvider = () =>
  Provider.succeed(StaticSiteCustomDomain, {
    stables: [
      "domainName",
      "staticSiteName",
      "resourceGroup",
      "customDomainId",
      "validationMethod",
    ],

    // Custom domains are removed with their static site.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.staticSiteName) !== lower(output.staticSiteName) ||
        lower(news.domainName) !== lower(output.domainName) ||
        (news.validationMethod ?? "cname-delegation") !==
          output.validationMethod
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const props = {
        resourceGroup: output?.resourceGroup ?? olds?.resourceGroup,
        staticSiteName: output?.staticSiteName ?? olds?.staticSiteName,
        domainName: output?.domainName ?? olds?.domainName,
        validationMethod:
          output?.validationMethod ??
          olds?.validationMethod ??
          "cname-delegation",
      };
      if (
        props.resourceGroup === undefined ||
        props.staticSiteName === undefined ||
        props.domainName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getDomain(
        subscriptionId,
        props.resourceGroup,
        props.staticSiteName,
        props.domainName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        {
          resourceGroup: props.resourceGroup,
          staticSiteName: props.staticSiteName,
          domainName: props.domainName,
          validationMethod: props.validationMethod,
        },
        observed,
      );
      // Custom domains carry no tags; only a domain this stack recorded is
      // known to be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const props = {
        resourceGroup: news.resourceGroup,
        staticSiteName: news.staticSiteName,
        domainName: news.domainName,
        validationMethod: news.validationMethod ?? "cname-delegation",
      };
      const get = getDomain(
        subscriptionId,
        props.resourceGroup,
        props.staticSiteName,
        props.domainName,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. Custom domains have no mutable properties.
      if (observed === undefined || observed.properties?.status === "Failed") {
        yield* web.StaticSitesCreateOrUpdateStaticSiteCustomDomain({
          subscriptionId,
          resourceGroupName: props.resourceGroup,
          name: props.staticSiteName,
          domainName: props.domainName,
          properties: { validationMethod: props.validationMethod },
        });
      }

      // A TXT-validated domain is usable once its token is issued; a
      // CNAME-validated one once Azure has verified the record.
      const ready = yield* waitForProvisioned(
        `custom domain ${props.domainName}`,
        get,
        (domain) => {
          const status = domain.properties?.status;
          if (status === "Ready") return undefined;
          if (status === "Failed") return "Failed";
          if (
            props.validationMethod === "dns-txt-token" &&
            domain.properties?.validationToken
          ) {
            return undefined;
          }
          return "InProgress";
        },
        { interval: "5 seconds", times: 60 },
      ).pipe(
        Effect.catchTag("Azure.ProvisioningFailed", () =>
          get.pipe(
            Effect.flatMap((domain) =>
              Effect.fail(
                new CustomDomainValidationFailed({
                  domainName: props.domainName,
                  message:
                    domain?.properties?.errorMessage ??
                    `Validation of ${props.domainName} failed`,
                }),
              ),
            ),
          ),
        ),
      );
      return toAttrs(props, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteStaticSiteStaticSiteCustomDomain({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.staticSiteName,
          domainName: output.domainName,
        }),
      );
      yield* waitUntilGone(
        `custom domain ${output.domainName}`,
        getDomain(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
          output.domainName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.StaticSite"],
    },
  });
