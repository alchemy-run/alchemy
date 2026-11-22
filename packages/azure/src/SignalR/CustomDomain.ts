import * as signalr from "@distilled.cloud/azure/signalr";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createSignalRName,
  lower,
  SIGNALR_NAMESPACE,
  signalROwnedByStage,
  WAIT,
  whileSignalRBusy,
} from "./internal.ts";

export interface CustomDomainProps {
  /**
   * Resource group of the SignalR service. Changing it replaces the domain.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * SignalR service the domain points at. Needs the `Premium_P1` tier or
   * higher. Changing it replaces the domain.
   */
  signalR: string;
  /**
   * Name of the custom domain resource. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * domain.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Fully qualified domain name, e.g. `realtime.example.com`. A CNAME
   * record `{domainName} → {signalRName}.service.signalr.net` must resolve
   * publicly before the domain is created. Changing it replaces the domain.
   */
  domainName: string;
  /**
   * ARM resource ID of the `Azure.SignalR.CustomCertificate` that covers
   * `domainName`.
   */
  customCertificateId: string;
}

export interface CustomDomain extends Resource<
  "Azure.SignalR.CustomDomain",
  CustomDomainProps,
  {
    /** Name of the custom domain resource. */
    customDomainName: string;
    /** ARM resource ID of the custom domain resource. */
    customDomainId: string;
    /** SignalR service that owns the domain. */
    signalR: string;
    /** Resource group of the SignalR service. */
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
 * A custom domain of an Azure SignalR Service
 * (`Microsoft.SignalRService/signalR/customDomains`). Clients connect to
 * `https://{domainName}` with the TLS certificate from an
 * `Azure.SignalR.CustomCertificate`. See the
 * [Azure docs](https://learn.microsoft.com/azure/azure-signalr/howto-custom-domain).
 *
 * :::caution
 * The service needs the `Premium_P1` tier or higher. A CNAME record
 * `{domainName} → {signalRName}.service.signalr.net` must resolve publicly
 * before you create the domain.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `signalR`, `name`, or `domainName` replaces the
 * domain. Alchemy updates `customCertificateId` in place.
 * :::
 *
 * ### Serving a Custom Domain
 * **Example:** Domain with a Key Vault certificate
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("certs");
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   sku: "Premium_P1",
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("SignalRReadsSecrets", {
 *   scope: vault.vaultId,
 *   principalId: signalR.principalId!,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.KeyVaultSecretsUser,
 *   principalType: "ServicePrincipal",
 * });
 * const certificate = yield* Azure.SignalR.CustomCertificate("tls", {
 *   signalR: signalR.signalRName,
 *   keyVaultBaseUri: vault.vaultUri,
 *   keyVaultSecretName: "realtime-example-com",
 * });
 * // CNAME realtime.example.com -> {signalR.signalRName}.service.signalr.net
 * const domain = yield* Azure.SignalR.CustomDomain("realtime", {
 *   signalR: signalR.signalRName,
 *   domainName: "realtime.example.com",
 *   customCertificateId: certificate.certificateId,
 * });
 * ```
 *
 * @resource
 */
export const CustomDomain = GroupedResource<CustomDomain>("Azure.SignalR.CustomDomain");

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    signalr.GetSignalRCustomDomain({
      subscriptionId,
      resourceGroupName,
      resourceName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  signalR: string,
  name: string,
  domain: signalr.GetSignalRCustomDomainResponse,
): CustomDomain["Attributes"] => ({
  customDomainName: name,
  customDomainId: domain.id ?? "",
  signalR,
  resourceGroup,
  domainName: domain.properties.domainName,
  customCertificateId: domain.properties.customCertificate.id ?? "",
});

const matches = (news: CustomDomainProps, observed: signalr.CustomDomainProperties | undefined) =>
  observed !== undefined &&
  lower(observed.domainName) === lower(news.domainName) &&
  lower(observed.customCertificate.id) === lower(news.customCertificateId);

export const CustomDomainProvider = () =>
  Provider.succeed(CustomDomain, {
    stables: ["customDomainName", "customDomainId", "signalR", "resourceGroup", "domainName"],

    // Custom domains are deleted with their SignalR service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.signalR) !== lower(output.signalR) ||
        (news.name !== undefined && lower(news.name) !== lower(output.customDomainName)) ||
        lower(news.domainName) !== lower(output.domainName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const signalR = output?.signalR ?? olds?.signalR;
      if (resourceGroup === undefined || signalR === undefined) {
        return undefined;
      }
      const name = output?.customDomainName ?? olds?.name ?? (yield* createSignalRName(id));
      const observed = yield* getDomain(subscriptionId, resourceGroup, signalR, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, signalR, name, observed);
      return (yield* signalROwnedByStage(subscriptionId, resourceGroup, signalR))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SIGNALR_NAMESPACE);
      const { resourceGroup, signalR } = news;
      const name = news.name ?? output?.customDomainName ?? (yield* createSignalRName(id));
      const get = getDomain(subscriptionId, resourceGroup, signalR, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full upsert; skip it when nothing changed.
      if (!matches(news, observed?.properties)) {
        yield* signalr
          .SignalRCustomDomainsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: signalR,
            name,
            properties: {
              domainName: news.domainName,
              customCertificate: { id: news.customCertificateId },
            },
          })
          .pipe(Effect.retry(whileSignalRBusy));
      }

      const fresh = yield* waitForProvisioned(
        `signalr custom domain ${name}`,
        get,
        (domain) => {
          const state = domain.properties.provisioningState;
          if (state !== undefined && state !== "Succeeded") return state;
          return matches(news, domain.properties) ? "Succeeded" : "Updating";
        },
        WAIT,
      );
      return toAttrs(resourceGroup, signalR, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        signalr
          .DeleteSignalRCustomDomain({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.signalR,
            name: output.customDomainName,
          })
          .pipe(Effect.retry(whileSignalRBusy)),
      );
      yield* waitUntilGone(
        `signalr custom domain ${output.customDomainName}`,
        getDomain(subscriptionId, output.resourceGroup, output.signalR, output.customDomainName),
        WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.SignalR.CustomCertificate",
        "Azure.SignalR.SignalR",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
