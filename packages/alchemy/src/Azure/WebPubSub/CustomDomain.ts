import * as webpubsub from "@distilled.cloud/azure/webpubsub";
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
  createWebPubSubName,
  lower,
  WEBPUBSUB_NAMESPACE,
  webPubSubOwnedByStage,
  WAIT,
  whileWebPubSubBusy,
} from "./internal.ts";

export interface CustomDomainProps {
  /** Resource group of the Web PubSub service. Changing it replaces the domain. */
  resourceGroup: string;
  /**
   * Web PubSub service the domain points at. Needs the `Premium_P1` tier or
   * higher. Changing it replaces the domain.
   */
  webPubSub: string;
  /**
   * Name of the custom domain resource. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * domain.
   */
  name?: string;
  /**
   * Fully qualified domain name, e.g. `realtime.example.com`. A CNAME
   * record `{domainName} → {webPubSubName}.webpubsub.azure.com` must resolve
   * publicly before the domain is created. Changing it replaces the domain.
   */
  domainName: string;
  /**
   * ARM resource ID of the `Azure.WebPubSub.CustomCertificate` that covers
   * `domainName`.
   */
  customCertificateId: string;
}

export interface CustomDomain extends Resource<
  "Azure.WebPubSub.CustomDomain",
  CustomDomainProps,
  {
    /** Name of the custom domain resource. */
    customDomainName: string;
    /** ARM resource ID of the custom domain resource. */
    customDomainId: string;
    /** Web PubSub service that owns the domain. */
    webPubSub: string;
    /** Resource group of the Web PubSub service. */
    resourceGroup: string;
    /** Fully qualified domain name. */
    domainName: string;
    /** ARM resource ID of the certificate bound to the domain. */
    customCertificateId: string;
  },
  never,
  Providers
> {}

/**
 * A custom domain of an Azure Web PubSub service. Clients connect to
 * `https://{domainName}` with the TLS certificate from an
 * `Azure.WebPubSub.CustomCertificate`.
 *
 * @see https://learn.microsoft.com/azure/azure-web-pubsub/howto-custom-domain
 *
 * ### Serving a Custom Domain
 * **Example:** Domain with a Key Vault certificate
 * ```typescript
 * // CNAME realtime.example.com -> {webPubSub.webPubSubName}.webpubsub.azure.com
 * const domain = yield* Azure.WebPubSub.CustomDomain("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   webPubSub: webPubSub.webPubSubName,
 *   domainName: "realtime.example.com",
 *   customCertificateId: certificate.certificateId,
 * });
 * ```
 *
 * @resource
 */
export const CustomDomain = Resource<CustomDomain>(
  "Azure.WebPubSub.CustomDomain",
);

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    webpubsub.GetWebPubSubCustomDomain({
      subscriptionId,
      resourceGroupName,
      resourceName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  webPubSub: string,
  name: string,
  domain: webpubsub.GetWebPubSubCustomDomainResponse,
): CustomDomain["Attributes"] => ({
  customDomainName: name,
  customDomainId: domain.id ?? "",
  webPubSub,
  resourceGroup,
  domainName: domain.properties.domainName,
  customCertificateId: domain.properties.customCertificate.id ?? "",
});

const matches = (
  news: CustomDomainProps,
  observed: webpubsub.CustomDomainProperties | undefined,
) =>
  observed !== undefined &&
  lower(observed.domainName) === lower(news.domainName) &&
  lower(observed.customCertificate.id) === lower(news.customCertificateId);

export const CustomDomainProvider = () =>
  Provider.succeed(CustomDomain, {
    stables: [
      "customDomainName",
      "customDomainId",
      "webPubSub",
      "resourceGroup",
      "domainName",
    ],

    // Custom domains are deleted with their Web PubSub service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.webPubSub) !== lower(output.webPubSub) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.customDomainName)) ||
        lower(news.domainName) !== lower(output.domainName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const webPubSub = output?.webPubSub ?? olds?.webPubSub;
      if (resourceGroup === undefined || webPubSub === undefined) {
        return undefined;
      }
      const name =
        output?.customDomainName ??
        olds?.name ??
        (yield* createWebPubSubName(id));
      const observed = yield* getDomain(
        subscriptionId,
        resourceGroup,
        webPubSub,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, webPubSub, name, observed);
      return (yield* webPubSubOwnedByStage(
        subscriptionId,
        resourceGroup,
        webPubSub,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, WEBPUBSUB_NAMESPACE);
      const { resourceGroup, webPubSub } = news;
      const name =
        news.name ??
        output?.customDomainName ??
        (yield* createWebPubSubName(id));
      const get = getDomain(subscriptionId, resourceGroup, webPubSub, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full upsert; skip it when nothing changed.
      if (!matches(news, observed?.properties)) {
        yield* webpubsub
          .WebPubSubCustomDomainsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: webPubSub,
            name,
            properties: {
              domainName: news.domainName,
              customCertificate: { id: news.customCertificateId },
            },
          })
          .pipe(Effect.retry(whileWebPubSubBusy));
      }

      const fresh = yield* waitForProvisioned(
        `web pubsub custom domain ${name}`,
        get,
        (domain) => {
          const state = domain.properties.provisioningState;
          if (state !== undefined && state !== "Succeeded") return state;
          return matches(news, domain.properties) ? "Succeeded" : "Updating";
        },
        WAIT,
      );
      return toAttrs(resourceGroup, webPubSub, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        webpubsub
          .DeleteWebPubSubCustomDomain({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.webPubSub,
            name: output.customDomainName,
          })
          .pipe(Effect.retry(whileWebPubSubBusy)),
      );
      yield* waitUntilGone(
        `web pubsub custom domain ${output.customDomainName}`,
        getDomain(
          subscriptionId,
          output.resourceGroup,
          output.webPubSub,
          output.customDomainName,
        ),
        WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.WebPubSub.CustomCertificate",
        "Azure.WebPubSub.WebPubSub",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
