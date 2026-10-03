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
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, reveal, sameLocation, siteWhere } from "./common.ts";

export interface SiteCertificateProps {
  /** Resource group of the app. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Name of the certificate. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Azure location; use the location of the app. Changing it replaces the
   * certificate.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Base64-encoded PFX (PKCS#12) file to upload. Changing it replaces the
   * certificate.
   */
  pfxBlob?: string | Redacted.Redacted<string>;
  /** Password of `pfxBlob`. Changing it replaces the certificate. */
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
   * Custom host name for a free App Service Managed Certificate (the host
   * name must be bound to the app). Changing it replaces the certificate.
   */
  canonicalName?: string;
  /** ARM ID of the App Service plan the certificate is associated with. */
  serverFarmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SiteCertificate extends Resource<
  "Azure.Web.SiteCertificate",
  SiteCertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Name of the app. */
    siteName: string;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Location of the certificate. */
    location: string;
    /** SHA-1 thumbprint; reference it from host name SSL bindings. */
    thumbprint: string;
    /** Subject name of the certificate. */
    subjectName: string | undefined;
    /** Host names the certificate covers. */
    hostNames: string[];
    /** Expiration date (ISO 8601). */
    expirationDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A TLS certificate scoped to a single App Service app
 * (`Microsoft.Web/sites/certificates`) instead of the whole resource group:
 * an uploaded PFX, a Key Vault reference, or a managed certificate. Only
 * the owning app can bind it. Requires a Basic or higher plan.
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-ssl-certificate
 *
 * ### Uploading a Certificate
 * **Example:** PFX scoped to one app
 * ```typescript
 * const cert = yield* Azure.Web.SiteCertificate("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   location: app.location,
 *   pfxBlob: Redacted.make(pfxBase64),
 *   password: Redacted.make(pfxPassword),
 * });
 * // cert.thumbprint
 * ```
 *
 * @resource
 */
export const SiteCertificate = Resource<SiteCertificate>(
  "Azure.Web.SiteCertificate",
);

type ObservedCertificate = web.GetSiteCertificateResponse;

const createCertificateName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getCertificate = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    web.GetSiteCertificate({
      ...siteWhere(subscriptionId, resourceGroup, siteName),
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  certificateName: string,
  cert: ObservedCertificate,
): SiteCertificate["Attributes"] => ({
  certificateName,
  certificateId: cert.id ?? "",
  siteName,
  resourceGroup,
  location: cert.location,
  thumbprint: cert.properties?.thumbprint ?? "",
  subjectName: cert.properties?.subjectName,
  hostNames: [...(cert.properties?.hostNames ?? [])],
  expirationDate: cert.properties?.expirationDate,
  tags: userTags(cert.tags),
});

export const SiteCertificateProvider = () =>
  Provider.succeed(SiteCertificate, {
    stables: [
      "certificateName",
      "certificateId",
      "siteName",
      "resourceGroup",
      "location",
    ],

    // Site certificates are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
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
      const siteName = output?.siteName ?? olds?.siteName;
      if (resourceGroup === undefined || siteName === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        siteName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName } = news;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createCertificateName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        ...siteWhere(subscriptionId, resourceGroup, siteName),
        certificateName: name,
      };
      const get = getCertificate(subscriptionId, resourceGroup, siteName, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The certificate body is immutable (changes replace it); the
      // PUT re-runs only when it is missing or its tags drift (the PATCH
      // body cannot carry tags).
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        yield* web.SiteCertificatesCreateOrUpdate({
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
        `site certificate ${name}`,
        get,
        (cert) => (cert.properties?.thumbprint ? undefined : "InProgress"),
        { interval: "5 seconds", times: 60 },
      );

      // Sync the associated plan against observed state.
      if (
        news.serverFarmId !== undefined &&
        lower(observed.properties?.serverFarmId) !== lower(news.serverFarmId)
      ) {
        yield* web.UpdateSiteCertificate({
          ...where,
          properties: { serverFarmId: news.serverFarmId },
        });
        observed = (yield* get) ?? observed;
      }

      return toAttrs(resourceGroup, siteName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteSiteCertificate({
          ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
          certificateName: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `site certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.certificateName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
      ],
    },
  });
