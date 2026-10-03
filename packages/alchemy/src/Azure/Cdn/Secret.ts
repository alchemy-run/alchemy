import * as cdn from "@distilled.cloud/azure/cdn";
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
import {
  AFD_DELETE_BUDGET,
  createAfdName,
  matchesDesired,
  profileOwnedByStack,
  ref,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface AfdSecretParameters {
  /**
   * Secret kind. `CustomerCertificate` and `MtlsCertificateChain` reference
   * a Key Vault certificate; `UrlSigningKey` a Key Vault secret.
   */
  type:
    | "CustomerCertificate"
    | "UrlSigningKey"
    | "MtlsCertificateChain"
    | "ManagedCertificate"
    | "AzureFirstPartyManagedCertificate";
  /**
   * ARM ID of the Key Vault secret, e.g.
   * `/subscriptions/.../providers/Microsoft.KeyVault/vaults/kv/secrets/cert`.
   */
  secretSourceId?: string;
  /** Pinned secret version. Omit with `useLatestVersion: true`. */
  secretVersion?: string;
  /** Follow the latest secret version automatically (certificates). */
  useLatestVersion?: boolean;
  /** Key ID used to sign URLs (`UrlSigningKey`). */
  keyId?: string;
  /** Subject alternative names the certificate covers (`CustomerCertificate`). */
  subjectAlternativeNames?: string[];
}

export interface SecretProps {
  /** Resource group of the profile. Changing it replaces the secret. */
  resourceGroup: string;
  /** Front Door profile that holds the secret. Changing it replaces the secret. */
  profile: string;
  /**
   * Secret name: letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the secret.
   */
  name?: string;
  /** Secret parameters. Secrets cannot be updated; any change replaces the secret. */
  parameters: AfdSecretParameters;
}

export interface Secret extends Resource<
  "Azure.Cdn.Secret",
  SecretProps,
  {
    /** Name of the secret. */
    secretName: string;
    /** ARM resource ID of the secret; reference it from custom domain TLS settings. */
    secretId: string;
    /** Front Door profile that holds the secret. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Secret kind. */
    type: string | undefined;
    /** Certificate subject, when the secret is a certificate. */
    subject: string | undefined;
    /** Certificate expiration date, when the secret is a certificate. */
    expirationDate: string | undefined;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door secret — a reference to a Key Vault certificate or URL
 * signing key that custom domains and rules use. The profile's managed
 * identity (or the Front Door service principal) needs read access to the
 * Key Vault.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/standard-premium/how-to-configure-https-custom-domain
 *
 * ### Bring Your Own Certificate
 * **Example:** Key Vault certificate for a custom domain
 * ```typescript
 * const cert = yield* Azure.Cdn.Secret("cert", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   parameters: {
 *     type: "CustomerCertificate",
 *     secretSourceId: `${vault.vaultId}/secrets/www-example-com`,
 *     useLatestVersion: true,
 *   },
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   hostName: "www.example.com",
 *   tlsSettings: { certificateType: "CustomerCertificate", secretId: cert.secretId },
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Azure.Cdn.Secret");

const createSecretName = (id: string) => createAfdName(id, 50);

const getSecret = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  secretName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetSecret({
      subscriptionId,
      resourceGroupName,
      profileName,
      secretName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  name: string,
  secret: cdn.GetSecretResponse,
): Secret["Attributes"] => ({
  secretName: name,
  secretId: secret.id ?? "",
  profile,
  resourceGroup,
  type: secret.properties?.parameters?.type,
  subject: secret.properties?.parameters?.subject,
  expirationDate: secret.properties?.parameters?.expirationDate,
  deploymentStatus: secret.properties?.deploymentStatus,
});

const toParameters = (parameters: AfdSecretParameters) => ({
  type: parameters.type,
  secretSource: ref(parameters.secretSourceId),
  secretVersion: parameters.secretVersion,
  useLatestVersion: parameters.useLatestVersion,
  keyId: parameters.keyId,
  subjectAlternativeNames: parameters.subjectAlternativeNames,
});

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["secretName", "secretId", "profile", "resourceGroup"],

    // Secrets are deleted with their profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        (news.name !== undefined && !sameName(news.name, output.secretName)) ||
        (olds !== undefined &&
          JSON.stringify(toParameters(olds.parameters)) !==
            JSON.stringify(toParameters(news.parameters)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      if (resourceGroup === undefined || profile === undefined)
        return undefined;
      const name =
        output?.secretName ?? olds?.name ?? (yield* createSecretName(id));
      const observed = yield* getSecret(
        subscriptionId,
        resourceGroup,
        profile,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, name, observed);
      return (yield* profileOwnedByStack(
        subscriptionId,
        resourceGroup,
        profile,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile } = news;
      const name =
        news.name ?? output?.secretName ?? (yield* createSecretName(id));
      const parameters = toParameters(news.parameters);
      const get = getSecret(subscriptionId, resourceGroup, profile, name);

      // Observe; secrets have no PATCH, so a missing or drifted (adopted)
      // secret is (re)written with a full PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !matchesDesired(parameters, observed.properties?.parameters)
      ) {
        yield* cdn
          .CreateSecret({
            subscriptionId,
            resourceGroupName: resourceGroup,
            profileName: profile,
            secretName: name,
            properties: { parameters },
          })
          .pipe(Effect.retry(whileProfileBusy));
      }
      const fresh = yield* waitForAfd(
        `Front Door secret ${name}`,
        get,
        (s) => s.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, profile, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteSecret({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            secretName: output.secretName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door secret ${output.secretName}`,
        getSecret(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.secretName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
