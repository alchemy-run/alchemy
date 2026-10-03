import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  accountOwnedByStage,
  childNuke,
  createChildName,
  reveal,
  sameName,
  sameText,
} from "./Common.ts";

export interface CertificateProps {
  /** Resource group of the Automation account. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Automation account that holds the certificate. Changing it replaces the certificate. */
  automationAccount: string;
  /**
   * Certificate name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Base64-encoded certificate: a `.cer` (public key only) or a `.pfx`
   * (with private key). Changing it replaces the certificate.
   */
  base64Value: Redacted.Redacted<string>;
  /**
   * Thumbprint of the certificate; Azure computes it when omitted.
   * Changing it replaces the certificate.
   */
  thumbprint?: string;
  /**
   * Whether the private key of a `.pfx` can be exported. Changing it
   * replaces the certificate.
   * @default false
   */
  isExportable?: boolean;
  /** Description of the certificate. */
  description?: string;
}

export interface Certificate extends Resource<
  "Azure.Automation.Certificate",
  CertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID of the certificate. */
    certificateId: string;
    /** Automation account that holds the certificate. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Thumbprint of the certificate. */
    thumbprint: string | undefined;
    /** Expiry time of the certificate. */
    expiryTime: string | undefined;
    /** Whether the private key is exportable. */
    isExportable: boolean;
    /** Description of the certificate. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A certificate asset in an Azure Automation account, read by runbooks and
 * DSC configurations with `Get-AutomationCertificate`.
 *
 * @see https://learn.microsoft.com/azure/automation/shared-resources/certificates
 *
 * ### Uploading a Certificate
 * **Example:** Public certificate
 * ```typescript
 * const cert = yield* Azure.Automation.Certificate("partner-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   base64Value: Redacted.make(partnerCaBase64),
 *   description: "Partner CA",
 * });
 * ```
 *
 * @resource
 */
export const Certificate = Resource<Certificate>(
  "Azure.Automation.Certificate",
);

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  certificateName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetCertificate({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      certificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  certificate: automation.GetCertificateResponse,
): Certificate["Attributes"] => ({
  certificateName: name,
  certificateId: certificate.id ?? "",
  automationAccount,
  resourceGroup,
  thumbprint: certificate.properties?.thumbprint,
  expiryTime: certificate.properties?.expiryTime,
  isExportable: certificate.properties?.isExportable ?? false,
  description: certificate.properties?.description,
});

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: [
      "certificateName",
      "certificateId",
      "automationAccount",
      "resourceGroup",
    ],

    // Certificates live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined &&
          !sameName(news.name, output.certificateName)) ||
        (news.isExportable ?? false) !== output.isExportable ||
        (news.thumbprint !== undefined &&
          !sameName(news.thumbprint, output.thumbprint)) ||
        (olds !== undefined &&
          reveal(olds.base64Value) !== reveal(news.base64Value))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.certificateName ?? (yield* createChildName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        certificateName: name,
      };
      const get = getCertificate(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The certificate content is fixed at creation.
      if (observed === undefined) {
        yield* automation.CertificateCreateOrUpdate({
          ...where,
          name,
          properties: {
            base64Value: reveal(news.base64Value) as string,
            thumbprint: news.thumbprint,
            isExportable: news.isExportable ?? false,
            description: news.description,
          },
        });
        observed = yield* waitForProvisioned(
          `automation certificate ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync the description against observed.
      if (!sameText(observed.properties?.description, news.description)) {
        observed = yield* automation.UpdateCertificate({
          ...where,
          name,
          properties: { description: news.description ?? "" },
        });
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          certificateName: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `automation certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.certificateName,
        ),
      );
    }),

    nuke: childNuke,
  });
