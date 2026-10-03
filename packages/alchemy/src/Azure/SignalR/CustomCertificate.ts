import * as signalr from "@distilled.cloud/azure/signalr";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  createSignalRName,
  lower,
  SIGNALR_NAMESPACE,
  signalROwnedByStage,
  WAIT,
  whileSignalRBusy,
} from "./internal.ts";

export interface CustomCertificateProps {
  /** Resource group of the SignalR service. Changing it replaces the certificate. */
  resourceGroup: string;
  /**
   * SignalR service that serves the certificate. Needs the `Premium_P1`
   * tier or higher and a managed identity that can read the certificate's
   * secret in Key Vault. Changing it replaces the certificate.
   */
  signalR: string;
  /**
   * Name of the certificate. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Base URI of the Key Vault that stores the certificate, e.g.
   * `https://my-vault.vault.azure.net/`. Changing it replaces the
   * certificate.
   */
  keyVaultBaseUri: string;
  /**
   * Name of the Key Vault secret (or certificate) holding the PFX.
   * Changing it replaces the certificate.
   */
  keyVaultSecretName: string;
  /**
   * Version of the secret. If omitted, the service tracks the latest
   * version.
   */
  keyVaultSecretVersion?: string;
}

export interface CustomCertificate extends Resource<
  "Azure.SignalR.CustomCertificate",
  CustomCertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID of the certificate; reference it from a custom domain. */
    certificateId: string;
    /** SignalR service that owns the certificate. */
    signalR: string;
    /** Resource group of the SignalR service. */
    resourceGroup: string;
    /** Base URI of the Key Vault that stores the certificate. */
    keyVaultBaseUri: string;
    /** Name of the Key Vault secret holding the certificate. */
    keyVaultSecretName: string;
    /** Pinned secret version, if any. */
    keyVaultSecretVersion: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A TLS certificate of an Azure SignalR Service, loaded from Key Vault with
 * the service's managed identity. Custom domains reference it by ID.
 *
 * @see https://learn.microsoft.com/azure/azure-signalr/howto-custom-domain
 *
 * ### Importing a Certificate from Key Vault
 * **Example:** Certificate read with the service's system identity
 * ```typescript
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium_P1",
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("SignalRReadsSecrets", {
 *   scope: vault.vaultId,
 *   principalId: signalR.principalId!,
 *   roleDefinitionId: "4633458b-17de-408a-b874-0445c86b69e6", // Key Vault Secrets User
 *   principalType: "ServicePrincipal",
 * });
 * const certificate = yield* Azure.SignalR.CustomCertificate("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   keyVaultBaseUri: vault.vaultUri,
 *   keyVaultSecretName: "realtime-example-com",
 * });
 * ```
 *
 * @resource
 */
export const CustomCertificate = Resource<CustomCertificate>(
  "Azure.SignalR.CustomCertificate",
);

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    signalr.GetSignalRCustomCertificate({
      subscriptionId,
      resourceGroupName,
      resourceName,
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  signalR: string,
  name: string,
  certificate: signalr.GetSignalRCustomCertificateResponse,
): CustomCertificate["Attributes"] => ({
  certificateName: name,
  certificateId: certificate.id ?? "",
  signalR,
  resourceGroup,
  keyVaultBaseUri: certificate.properties.keyVaultBaseUri,
  keyVaultSecretName: certificate.properties.keyVaultSecretName,
  keyVaultSecretVersion: certificate.properties.keyVaultSecretVersion,
});

const sameUri = (a: string | undefined, b: string | undefined) =>
  lower(a)?.replace(/\/+$/, "") === lower(b)?.replace(/\/+$/, "");

const matches = (
  news: CustomCertificateProps,
  observed: signalr.CustomCertificateProperties | undefined,
) =>
  observed !== undefined &&
  sameUri(observed.keyVaultBaseUri, news.keyVaultBaseUri) &&
  lower(observed.keyVaultSecretName) === lower(news.keyVaultSecretName) &&
  (observed.keyVaultSecretVersion ?? "") === (news.keyVaultSecretVersion ?? "");

export const CustomCertificateProvider = () =>
  Provider.succeed(CustomCertificate, {
    stables: [
      "certificateName",
      "certificateId",
      "signalR",
      "resourceGroup",
      "keyVaultBaseUri",
      "keyVaultSecretName",
    ],

    // Certificates are deleted with their SignalR service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.signalR) !== lower(output.signalR) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.certificateName)) ||
        !sameUri(news.keyVaultBaseUri, output.keyVaultBaseUri) ||
        lower(news.keyVaultSecretName) !== lower(output.keyVaultSecretName)
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
      const name =
        output?.certificateName ?? olds?.name ?? (yield* createSignalRName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        signalR,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, signalR, name, observed);
      return (yield* signalROwnedByStage(
        subscriptionId,
        resourceGroup,
        signalR,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SIGNALR_NAMESPACE);
      const { resourceGroup, signalR } = news;
      const name =
        news.name ?? output?.certificateName ?? (yield* createSignalRName(id));
      const get = getCertificate(subscriptionId, resourceGroup, signalR, name);

      // Observe, then ensure + sync: the PUT is a full upsert, skipped when
      // the observed certificate already matches. A certificate the service
      // could not load (state `Failed`, typically while its identity's Key
      // Vault access is still propagating) is written again.
      const converge = Effect.gen(function* () {
        const observed = yield* get;
        if (
          !matches(news, observed?.properties) ||
          observed?.properties.provisioningState === "Failed"
        ) {
          yield* signalr
            .SignalRCustomCertificatesCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              resourceName: signalR,
              certificateName: name,
              properties: {
                keyVaultBaseUri: news.keyVaultBaseUri,
                keyVaultSecretName: news.keyVaultSecretName,
                keyVaultSecretVersion: news.keyVaultSecretVersion,
              },
            })
            .pipe(Effect.retry(whileSignalRBusy));
        }
        return yield* waitForProvisioned(
          `signalr custom certificate ${name}`,
          get,
          (certificate) => {
            const state = certificate.properties.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return matches(news, certificate.properties)
              ? "Succeeded"
              : "Updating";
          },
          WAIT,
        );
      });
      const fresh = yield* converge.pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.ProvisioningFailed",
          schedule: Schedule.spaced("30 seconds"),
          times: 3,
        }),
      );
      return toAttrs(resourceGroup, signalR, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        signalr
          .DeleteSignalRCustomCertificate({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.signalR,
            certificateName: output.certificateName,
          })
          .pipe(Effect.retry(whileSignalRBusy)),
      );
      yield* waitUntilGone(
        `signalr custom certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.signalR,
          output.certificateName,
        ),
        WAIT,
      );
    }),

    nuke: {
      dependsOn: ["Azure.SignalR.SignalR", "Azure.Resources.ResourceGroup"],
    },
  });
