import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import { createEntityName, isParentOwned, sameName } from "./Common.ts";

export interface CertificateKeyVault {
  /**
   * Key Vault secret identifier of the certificate, e.g.
   * `https://{vault}.vault.azure.net/secrets/{name}`. Omit the version to
   * follow the latest version automatically.
   */
  secretIdentifier: string;
  /**
   * Client ID of the user-assigned identity used to read the secret.
   * @default the service's system-assigned identity
   */
  identityClientId?: string;
}

export interface CertificateProps {
  /** Resource group of the API Management service. Changing it replaces the certificate. */
  resourceGroup: string;
  /** API Management service that holds the certificate. Changing it replaces the certificate. */
  serviceName: string;
  /**
   * Certificate identifier (1-80 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the certificate.
   */
  name?: string;
  /**
   * Base64-encoded PKCS#12 (PFX) certificate with its private key.
   * Exactly one of `data` and `keyVault` must be set.
   */
  data?: string | Redacted.Redacted<string>;
  /** Password of the PFX in `data`. */
  password?: string | Redacted.Redacted<string>;
  /** Key Vault reference; the service identity needs `get` access to the secret. */
  keyVault?: CertificateKeyVault;
}

export interface Certificate extends Resource<
  "Azure.ApiManagement.Certificate",
  CertificateProps,
  {
    /** Certificate identifier. */
    certificateName: string;
    /** ARM resource ID of the certificate; use it in backend credentials. */
    certificateId: string;
    /** API Management service that holds the certificate. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** SHA-1 thumbprint (uppercase hex). */
    thumbprint: string;
    /** Subject distinguished name. */
    subject: string;
    /** Expiration date (ISO 8601). */
    expirationDate: string;
  },
  never,
  Providers
> {}

/**
 * A client certificate stored in an API Management service, used for
 * mutual TLS to backends (`Backend.credentials.certificateIds`) and for
 * self-hosted gateway hostnames. A service stores each certificate
 * (thumbprint) only once.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-mutual-certificates
 *
 * ### Uploading a Certificate
 * **Example:** PFX certificate with a password
 * ```typescript
 * const cert = yield* Azure.ApiManagement.Certificate("backend-client", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   data: Redacted.make(pfxBase64),
 *   password: Redacted.make(pfxPassword),
 * });
 * ```
 *
 * ### Key Vault References
 * **Example:** Certificate read from Key Vault
 * ```typescript
 * const cert = yield* Azure.ApiManagement.Certificate("backend-client", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   keyVault: {
 *     secretIdentifier: "https://my-vault.vault.azure.net/secrets/client-cert",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Certificate = Resource<Certificate>(
  "Azure.ApiManagement.Certificate",
);

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  certificateId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetCertificate({
      subscriptionId,
      resourceGroupName,
      serviceName,
      certificateId,
    }),
  );

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  certificate: apim.GetCertificateResponse,
): Certificate["Attributes"] => ({
  certificateName: name,
  certificateId: certificate.id ?? "",
  serviceName,
  resourceGroup,
  thumbprint: certificate.properties?.thumbprint ?? "",
  subject: certificate.properties?.subject ?? "",
  expirationDate: certificate.properties?.expirationDate ?? "",
});

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: [
      "certificateName",
      "certificateId",
      "serviceName",
      "resourceGroup",
    ],

    // Certificates live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName)
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.name !== undefined &&
        !sameName(news.name, output.certificateName)
      ) {
        // A service stores each certificate (thumbprint) only once, so a
        // renamed certificate with unchanged content must be deleted first.
        const sameContent =
          olds !== undefined &&
          reveal(olds.data) === reveal(news.data) &&
          olds.keyVault?.secretIdentifier === news.keyVault?.secretIdentifier;
        return { action: "replace", deleteFirst: sameContent } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.certificateName ?? (yield* createEntityName(id));
      const get = getCertificate(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );

      // Observe. GET exposes only the thumbprint/subject, never the PFX, so
      // the previous props are the baseline for content changes; without
      // them (adoption) the certificate is always uploaded.
      const observed = yield* get;
      const keyVault = observed?.properties?.keyVault;
      const inSync =
        observed !== undefined &&
        olds !== undefined &&
        reveal(olds.data) === reveal(news.data) &&
        reveal(olds.password) === reveal(news.password) &&
        (news.keyVault === undefined
          ? keyVault?.secretIdentifier === undefined
          : keyVault?.secretIdentifier === news.keyVault.secretIdentifier &&
            (news.keyVault.identityClientId === undefined ||
              keyVault?.identityClientId === news.keyVault.identityClientId));

      if (!inSync) {
        yield* apim.CertificateCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serviceName,
          certificateId: name,
          properties: {
            data: news.keyVault !== undefined ? undefined : reveal(news.data),
            password:
              news.keyVault !== undefined ? undefined : reveal(news.password),
            keyVault: news.keyVault,
          },
        });
      }
      // Key Vault references are fetched asynchronously (202), so wait for
      // the certificate to become readable.
      const current = yield* waitForProvisioned(
        `API Management certificate ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          certificateId: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `API Management certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.certificateName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
