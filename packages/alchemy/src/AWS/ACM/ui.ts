import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountConfiguration } from "./AccountConfiguration.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Dashboard UI providers for AWS ACM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** ACM brand color (AWS Security, Identity & Compliance red). */
const ACM_COLOR = "#DD344C";

/** Parse the region segment out of a certificate ARN. */
const arnRegion = (arn: string | undefined) => arn?.split(":")[3];

/** Parse the certificate UUID out of a certificate ARN. */
const arnCertificateId = (arn: string | undefined) => arn?.split("/")[1];

export const CertificateUI = UIProvider.succeed<Certificate>(
  "AWS.ACM.Certificate",
  {
    displayName: "ACM Certificate",
    icon: "shield-check",
    color: ACM_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.domainName,
    consoleUrl: (ctx) => {
      const region = arnRegion(ctx.attrs?.certificateArn);
      const id = arnCertificateId(ctx.attrs?.certificateArn);
      return region === undefined || id === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/acm/home?region=${region}#/certificates/${id}`;
    },
    facts: (ctx) => [
      { label: "domain", value: ctx.attrs?.domainName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.certificateArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "validation", value: ctx.attrs?.validationMethod },
      { label: "key algorithm", value: ctx.attrs?.keyAlgorithm },
      {
        label: "alt names",
        value: ctx.attrs?.subjectAlternativeNames?.join(", "),
      },
      { label: "hosted zone", value: ctx.attrs?.hostedZoneId, mono: true },
    ],
  },
);

export const AccountConfigurationUI = UIProvider.succeed<AccountConfiguration>(
  "AWS.ACM.AccountConfiguration",
  {
    displayName: "ACM Account Configuration",
    icon: "settings",
    color: ACM_COLOR,
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.daysBeforeExpiry === undefined
        ? undefined
        : `${ctx.attrs.daysBeforeExpiry} days before expiry`,
    facts: (ctx) => [
      { label: "days before expiry", value: ctx.attrs?.daysBeforeExpiry },
    ],
  },
);

export const ui = () => Layer.mergeAll(CertificateUI, AccountConfigurationUI);
