import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  createContainerAppsName,
  getConnectedEnvironment,
  lower,
  reveal,
  sameLocation,
} from "./common.ts";

export interface ConnectedEnvironmentCertificateProps {
  /**
   * Resource group of the connected environment. Changing it replaces the
   * certificate.
   */
  resourceGroup: string;
  /**
   * Name of the connected environment. Changing it replaces the
   * certificate.
   */
  environment: string;
  /**
   * Certificate name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the certificate.
   */
  name?: string;
  /**
   * Azure location; must match the environment. Changing it replaces the
   * certificate.
   * @default the environment's location
   */
  location?: string;
  /**
   * Base64-encoded PFX (PKCS#12) file to upload. Changing it replaces the
   * certificate.
   */
  value?: string | Redacted.Redacted<string>;
  /** Password of the PFX in `value`. Changing it replaces the certificate. */
  password?: string | Redacted.Redacted<string>;
  /**
   * Key Vault secret URL of the certificate (instead of `value`). Changing
   * it replaces the certificate.
   */
  keyVaultUrl?: string;
  /**
   * Managed identity (ARM ID, or `system`) of the environment used to read
   * `keyVaultUrl`. Changing it replaces the certificate.
   */
  keyVaultIdentity?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConnectedEnvironmentCertificate extends Resource<
  "Azure.ContainerApps.ConnectedEnvironmentCertificate",
  ConnectedEnvironmentCertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID; reference it from an app's custom domain binding. */
    certificateId: string;
    /** Name of the connected environment that holds the certificate. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** Location of the certificate. */
    location: string;
    /** Subject name of the certificate. */
    subjectName: string | undefined;
    /** Subject alternative names of the certificate. */
    subjectAlternativeNames: string[];
    /** Issuer of the certificate. */
    issuer: string | undefined;
    /** SHA-1 thumbprint. */
    thumbprint: string | undefined;
    /** Expiration date (ISO 8601). */
    expirationDate: string | undefined;
    /** Whether the certificate is valid. */
    valid: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A TLS certificate uploaded to a Container Apps connected environment
 * (`Microsoft.App/connectedEnvironments/certificates`), for binding custom
 * domains on the environment's apps. Upload a PFX or reference a Key Vault
 * secret.
 *
 * The certificate contents are immutable: changing them replaces the
 * certificate. Only tags update in place.
 *
 * @see https://learn.microsoft.com/azure/container-apps/custom-domains-certificates
 *
 * ### Uploading a Certificate
 * **Example:** PFX certificate
 * ```typescript
 * const cert = yield* Azure.ContainerApps.ConnectedEnvironmentCertificate("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: arcEnv.environmentName,
 *   value: Redacted.make(pfxBase64),
 *   password: Redacted.make(pfxPassword),
 * });
 * ```
 *
 * ### Key Vault Certificates
 * **Example:** Reference a Key Vault secret with the environment's identity
 * ```typescript
 * const cert = yield* Azure.ContainerApps.ConnectedEnvironmentCertificate("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: arcEnv.environmentName,
 *   keyVaultUrl: "https://my-vault.vault.azure.net/secrets/tls",
 *   keyVaultIdentity: "system",
 * });
 * ```
 *
 * @resource
 */
export const ConnectedEnvironmentCertificate =
  Resource<ConnectedEnvironmentCertificate>(
    "Azure.ContainerApps.ConnectedEnvironmentCertificate",
  );

const createCertificateName = (id: string) => createContainerAppsName(id, 60);

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  connectedEnvironmentName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    app.GetConnectedEnvironmentsCertificate({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetConnectedEnvironmentsCertificateResponse,
): ConnectedEnvironmentCertificate["Attributes"] => ({
  certificateName: name,
  certificateId: observed.id ?? "",
  environment,
  resourceGroup,
  location: observed.location,
  subjectName: observed.properties?.subjectName,
  subjectAlternativeNames: [
    ...(observed.properties?.subjectAlternativeNames ?? []),
  ],
  issuer: observed.properties?.issuer,
  thumbprint: observed.properties?.thumbprint,
  expirationDate: observed.properties?.expirationDate,
  valid: observed.properties?.valid,
  tags: userTags(observed.tags),
});

export const ConnectedEnvironmentCertificateProvider = () =>
  Provider.succeed(ConnectedEnvironmentCertificate, {
    stables: [
      "certificateName",
      "certificateId",
      "environment",
      "resourceGroup",
      "location",
      "thumbprint",
    ],

    // Certificates live inside an environment; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        (news.name !== undefined && news.name !== output.certificateName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (olds !== undefined &&
          (reveal(news.value) !== reveal(olds.value) ||
            reveal(news.password) !== reveal(olds.password) ||
            lower(news.keyVaultUrl) !== lower(olds.keyVaultUrl) ||
            lower(news.keyVaultIdentity) !== lower(olds.keyVaultIdentity)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      if (resourceGroup === undefined || environment === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, environment, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, environment } = news;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createCertificateName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        connectedEnvironmentName: environment,
        certificateName: name,
      };
      const get = getCertificate(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      const ready = waitForProvisioned(
        `connected environment certificate ${name}`,
        get,
        (cert) => cert.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. A certificate must live in its environment's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getConnectedEnvironment(
            subscriptionId,
            resourceGroup,
            environment,
          ))?.location ??
          (yield* AzureEnvironment.current).location;
        yield* app.ConnectedEnvironmentsCertificatesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            value: reveal(news.value),
            password: reveal(news.password),
            certificateKeyVaultProperties:
              news.keyVaultUrl === undefined
                ? undefined
                : {
                    keyVaultUrl: news.keyVaultUrl,
                    identity: news.keyVaultIdentity,
                  },
          },
        });
      }
      observed = yield* ready;

      // Sync tags; the certificate contents are immutable.
      if (tagsDiffer(observed.tags, tags)) {
        yield* app.UpdateConnectedEnvironmentsCertificate({ ...where, tags });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, environment, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteConnectedEnvironmentsCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectedEnvironmentName: output.environment,
          certificateName: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `connected environment certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.certificateName,
        ),
      );
    }),
  });
