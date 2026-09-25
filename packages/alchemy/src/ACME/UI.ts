import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Account } from "./Account.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Dashboard UI providers for ACME resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no ACME client code reaches the dashboard bundle.
 */

const ACME_COLOR = "#2C6BED";

const hostOf = (url: string | undefined) => {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const AccountUI = UIProvider.succeed<Account>("ACME.Account", {
  displayName: "ACME Account",
  icon: "key-round",
  color: ACME_COLOR,
  category: "security",
  summary: (ctx) => hostOf(ctx.attrs?.directoryUrl),
  facts: (ctx) => [
    {
      label: "account url",
      value: ctx.attrs?.accountUrl,
      mono: true,
      copy: true,
    },
    {
      label: "directory",
      value: ctx.attrs?.directoryUrl,
      mono: true,
      href: ctx.attrs?.directoryUrl,
    },
    { label: "status", value: ctx.attrs?.status },
    { label: "contact", value: ctx.attrs?.contact?.join(", ") },
    { label: "key algorithm", value: ctx.attrs?.keyAlgorithm },
    { label: "private ca", value: ctx.attrs?.trustedRoot !== undefined },
  ],
});

export const CertificateUI = UIProvider.succeed<Certificate>(
  "ACME.Certificate",
  {
    displayName: "ACME Certificate",
    icon: "shield-check",
    color: ACME_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.identifiers?.[0],
    facts: (ctx) => [
      {
        label: "identifiers",
        value: ctx.attrs?.identifiers?.join(", "),
        mono: true,
        copy: true,
      },
      { label: "issuer", value: ctx.attrs?.issuer },
      { label: "serial", value: ctx.attrs?.serial, mono: true, copy: true },
      { label: "not before", value: ctx.attrs?.notBefore },
      { label: "not after", value: ctx.attrs?.notAfter },
      { label: "key algorithm", value: ctx.attrs?.keyAlgorithm },
      {
        label: "order",
        value: ctx.attrs?.orderUrl,
        mono: true,
        href: ctx.attrs?.orderUrl,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(AccountUI, CertificateUI);
