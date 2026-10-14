import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Alias } from "./Alias.ts";
import type { Key } from "./Key.ts";

/**
 * Dashboard UI providers for AWS PaymentCryptography resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance (Payment Cryptography) brand red. */
const COLOR = "#DD344C";

export const KeyUI = UIProvider.succeed<Key>("AWS.PaymentCryptography.Key", {
  displayName: "Payment Cryptography Key",
  icon: "key-round",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.keyArn,
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.keyArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.keyState },
    {
      label: "check value",
      value: ctx.attrs?.keyCheckValue,
      mono: true,
    },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "exportable", value: ctx.attrs?.exportable },
    { label: "algorithm", value: ctx.props?.keyAttributes?.keyAlgorithm },
  ],
});

export const AliasUI = UIProvider.succeed<Alias>(
  "AWS.PaymentCryptography.Alias",
  {
    displayName: "Payment Cryptography Alias",
    icon: "tag",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.aliasName,
    facts: (ctx) => [
      { label: "alias", value: ctx.attrs?.aliasName, mono: true, copy: true },
      { label: "key", value: ctx.attrs?.keyArn, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(KeyUI, AliasUI);
