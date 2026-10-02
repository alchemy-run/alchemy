import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";
import type { CertificateAuthorityPolicy } from "./CertificateAuthorityPolicy.ts";
import type { Permission } from "./Permission.ts";

/**
 * Dashboard UI providers for AWS ACMPCA resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const ACMPCA_COLOR = "#DD344C";

export const CertificateAuthorityUI = UIProvider.succeed<CertificateAuthority>(
  "AWS.ACMPCA.CertificateAuthority",
  {
    displayName: "ACM PCA Certificate Authority",
    icon: "shield-check",
    color: ACMPCA_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.certificateAuthorityArn,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.certificateAuthorityArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "type", value: ctx.props?.type },
      { label: "common name", value: ctx.props?.subject?.commonName },
      { label: "key algorithm", value: ctx.props?.keyAlgorithm },
      { label: "usage mode", value: ctx.props?.usageMode },
    ],
  },
);

export const CertificateAuthorityPolicyUI =
  UIProvider.succeed<CertificateAuthorityPolicy>(
    "AWS.ACMPCA.CertificateAuthorityPolicy",
    {
      displayName: "ACM PCA Authority Policy",
      icon: "file-text",
      color: ACMPCA_COLOR,
      category: "security",
      summary: (ctx) => ctx.attrs?.certificateAuthorityArn,
      facts: (ctx) => [
        {
          label: "authority",
          value: ctx.attrs?.certificateAuthorityArn,
          mono: true,
          copy: true,
        },
        { label: "policy", value: ctx.attrs?.policy, mono: true },
      ],
    },
  );

export const PermissionUI = UIProvider.succeed<Permission>(
  "AWS.ACMPCA.Permission",
  {
    displayName: "ACM PCA Permission",
    icon: "key-round",
    color: ACMPCA_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.principal,
    facts: (ctx) => [
      {
        label: "authority",
        value: ctx.attrs?.certificateAuthorityArn,
        mono: true,
        copy: true,
      },
      { label: "principal", value: ctx.attrs?.principal, mono: true },
      {
        label: "actions",
        value: ctx.props?.actions?.join(", "),
        mono: true,
      },
      { label: "source account", value: ctx.props?.sourceAccount, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    CertificateAuthorityUI,
    CertificateAuthorityPolicyUI,
    PermissionUI,
  );
