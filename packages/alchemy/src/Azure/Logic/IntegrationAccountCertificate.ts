import * as logic from "@distilled.cloud/azure/logic";
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
  artifactDiffers,
  artifactMetadata,
  createLogicName,
  definedOnly,
  HASH_KEY,
  hashOf,
  isOwnedByMetadata,
  userMetadata,
} from "./LogicShared.ts";

/** A private key stored in Azure Key Vault. */
export interface IntegrationAccountCertificateKey {
  /** ARM resource ID of the key vault. */
  keyVault: string;
  /** Name of the key. */
  keyName: string;
  /** Key version. Omit for the latest version. */
  keyVersion?: string;
}

export interface IntegrationAccountCertificateProps {
  /** Resource group of the integration account. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the certificate. */
  integrationAccount: string;
  /**
   * Certificate name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Base64-encoded public certificate (DER `.cer`). Provide it alone for
   * a public certificate, or with `key` for a private certificate.
   */
  publicCertificate?: string;
  /** Private key in Key Vault (private certificates). */
  key?: IntegrationAccountCertificateKey;
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountCertificate extends Resource<
  "Azure.Logic.IntegrationAccountCertificate",
  IntegrationAccountCertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Base64-encoded public certificate. */
    publicCertificate: string | undefined;
    /** Time the certificate was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A certificate in a Logic Apps integration account, used to sign,
 * encrypt, and verify AS2 messages. A public certificate needs only the
 * base64 `.cer`; a private certificate references a key in Key Vault.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-enterprise-integration-certificates
 *
 * ### Adding Certificates
 * **Example:** Public certificate
 * ```typescript
 * const partnerCert = yield* Azure.Logic.IntegrationAccountCertificate("fabrikam", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   publicCertificate: cerBase64,
 * });
 * ```
 *
 * **Example:** Private certificate backed by Key Vault
 * ```typescript
 * const signing = yield* Azure.Logic.IntegrationAccountCertificate("signing", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   publicCertificate: cerBase64,
 *   key: { keyVault: vaultId, keyName: "as2-signing" },
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountCertificate =
  Resource<IntegrationAccountCertificate>(
    "Azure.Logic.IntegrationAccountCertificate",
  );

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountCertificate({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountCertificateResponse,
): IntegrationAccountCertificate["Attributes"] => ({
  certificateName: name,
  integrationAccount,
  resourceGroup,
  certificateId: observed.id ?? "",
  publicCertificate: observed.properties.publicCertificate,
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountCertificateProvider = () =>
  Provider.succeed(IntegrationAccountCertificate, {
    stables: [
      "certificateName",
      "integrationAccount",
      "resourceGroup",
      "certificateId",
    ],

    // Artifacts live inside an integration account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.integrationAccount.toLowerCase() !==
          output.integrationAccount.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.certificateName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const integrationAccount =
        output?.integrationAccount ?? olds?.integrationAccount;
      if (resourceGroup === undefined || integrationAccount === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, integrationAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const { resourceGroup, integrationAccount } = news;
      const name =
        news.name ?? output?.certificateName ?? (yield* createLogicName(id));
      const properties = {
        publicCertificate: news.publicCertificate,
        key:
          news.key === undefined
            ? undefined
            : {
                keyVault: { id: news.key.keyVault },
                keyName: news.key.keyName,
                keyVersion: news.key.keyVersion,
              },
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full replacement; changes
      // to fields Azure does not echo surface through the metadata hash.
      if (
        observed === undefined ||
        artifactDiffers(
          observed.properties,
          metadata,
          definedOnly({
            publicCertificate: properties.publicCertificate,
            key:
              properties.key === undefined
                ? undefined
                : definedOnly({
                    keyName: properties.key.keyName,
                    keyVersion: properties.key.keyVersion,
                  }),
          }),
        )
      ) {
        observed = yield* logic.IntegrationAccountCertificatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          integrationAccountName: integrationAccount,
          certificateName: name,
          properties: { ...properties, metadata },
        });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          certificateName: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `integration account certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.certificateName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
