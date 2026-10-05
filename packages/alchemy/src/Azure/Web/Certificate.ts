import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, reveal, sameLocation } from "./common.ts";

export interface CertificateProps {
  /**
   * Resource group the certificate is created in. Changing it replaces the
   * certificate.
   */
  resourceGroup: string;
  /**
   * Name of the certificate resource. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the certificate.
   */
  name?: string;
  /**
   * Azure location; use the location of the apps that bind it. Changing it
   * replaces the certificate.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Base64-encoded PFX (PKCS#12) file to upload. Changing it replaces the
   * certificate.
   */
  pfxBlob?: string | Redacted.Redacted<string>;
  /**
   * Password of `pfxBlob`. Changing it replaces the certificate.
   */
  password?: string | Redacted.Redacted<string>;
  /**
   * ARM ID of a Key Vault holding the certificate (instead of `pfxBlob`).
   * Changing it replaces the certificate.
   */
  keyVaultId?: string;
  /**
   * Name of the Key Vault secret holding the certificate. Changing it
   * replaces the certificate.
   */
  keyVaultSecretName?: string;
  /**
   * Custom host name for a free App Service Managed Certificate (requires
   * the host name to be bound to an app on a Basic or higher plan).
   * Changing it replaces the certificate.
   */
  canonicalName?: string;
  /**
   * ARM ID of the App Service plan the certificate is associated with.
   * Required for managed certificates.
   */
  serverFarmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Certificate extends Resource<
  "Azure.Web.Certificate",
  CertificateProps,
  {
    /** Name of the certificate resource. */
    certificateName: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Resource group that holds the certificate. */
    resourceGroup: string;
    /** Location of the certificate. */
    location: string;
    /** SHA-1 thumbprint; reference it from host name SSL bindings. */
    thumbprint: string;
    /** Subject name of the certificate. */
    subjectName: string | undefined;
    /** Issuer of the certificate. */
    issuer: string | undefined;
    /** Host names the certificate covers. */
    hostNames: string[];
    /** Expiration date (ISO 8601). */
    expirationDate: string | undefined;
    /** ARM ID of the associated App Service plan, if any. */
    serverFarmId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A TLS certificate for App Service (`Microsoft.Web/certificates`): an
 * uploaded PFX, a Key Vault reference, or a free App Service Managed
 * Certificate for a bound custom host name.
 *
 * Bind it to an app's custom domain by its `thumbprint`. Binding with SNI
 * requires a Basic or higher plan.
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-ssl-certificate
 *
 * ### Uploading a Certificate
 * **Example:** PFX upload
 * ```typescript
 * const cert = yield* Azure.Web.Certificate("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   pfxBlob: Redacted.make(pfxBase64),
 *   password: Redacted.make(pfxPassword),
 * });
 * // cert.thumbprint
 * ```
 *
 * ### Managed Certificates
 * **Example:** Free managed certificate for a bound host name
 * ```typescript
 * const cert = yield* Azure.Web.Certificate("www", {
 *   resourceGroup: group.resourceGroupName,
 *   canonicalName: "www.example.com",
 *   serverFarmId: plan.appServicePlanId,
 * });
 * ```
 *
 * @resource
 */
export const Certificate = Resource<Certificate>("Azure.Web.Certificate");

type ObservedCertificate = web.GetCertificateResponse;

const createCertificateName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetCertificate({ subscriptionId, resourceGroupName, name }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  cert: ObservedCertificate,
): Certificate["Attributes"] => ({
  certificateName: name,
  certificateId: cert.id ?? "",
  resourceGroup,
  location: cert.location,
  thumbprint: cert.properties?.thumbprint ?? "",
  subjectName: cert.properties?.subjectName,
  issuer: cert.properties?.issuer,
  hostNames: [...(cert.properties?.hostNames ?? [])],
  expirationDate: cert.properties?.expirationDate,
  serverFarmId: cert.properties?.serverFarmId,
  tags: userTags(cert.tags),
});

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["certificateName", "certificateId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* web
        .ListCertificates({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListCertificates", page)),
        );
      return (page.value ?? []).flatMap((cert) => {
        const group = resourceGroupOf(cert.id);
        return hasAnyAlchemyTag(cert.tags) &&
          group !== undefined &&
          cert.name !== undefined
          ? [toAttrs(group, cert.name, cert)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.certificateName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        reveal(news.pfxBlob) !== reveal(olds?.pfxBlob) ||
        reveal(news.password) !== reveal(olds?.password) ||
        lower(news.keyVaultId) !== lower(olds?.keyVaultId) ||
        news.keyVaultSecretName !== olds?.keyVaultSecretName ||
        lower(news.canonicalName) !== lower(olds?.canonicalName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createCertificateName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const get = getCertificate(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The certificate body is immutable (changes replace it); the
      // PUT re-runs only when the certificate is missing or its tags drift
      // (the PATCH body cannot carry tags and Microsoft.Web rejects the
      // generic tags API).
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        yield* web.CertificatesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            pfxBlob: reveal(news.pfxBlob),
            password: reveal(news.password),
            keyVaultId: news.keyVaultId,
            keyVaultSecretName: news.keyVaultSecretName,
            canonicalName: news.canonicalName,
            serverFarmId: news.serverFarmId,
          },
        });
      }
      // Managed certificates are issued asynchronously; they are usable
      // once they carry a thumbprint.
      observed = yield* waitForProvisioned(
        `certificate ${name}`,
        get,
        (cert) => (cert.properties?.thumbprint ? undefined : "InProgress"),
        { interval: "5 seconds", times: 60 },
      );

      // Sync the associated plan against observed state.
      if (
        news.serverFarmId !== undefined &&
        lower(observed.properties?.serverFarmId) !== lower(news.serverFarmId)
      ) {
        yield* web.UpdateCertificate({
          ...where,
          properties: { serverFarmId: news.serverFarmId },
        });
        observed = (yield* get) ?? observed;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.certificateName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.AppServicePlan"],
    },
  });
