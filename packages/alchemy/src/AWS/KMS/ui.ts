import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Alias } from "./Alias.ts";
import type { Key } from "./Key.ts";

/**
 * Dashboard UI providers for AWS KMS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */
export const KeyUI = UIProvider.succeed<Key>("AWS.KMS.Key", {
  displayName: "KMS Key",
  icon: "key-round",
  color: "#DD344C",
  category: "security",
  summary: (ctx) => ctx.attrs?.keyId,
  consoleUrl: (ctx) =>
    ctx.attrs?.keyId === undefined
      ? undefined
      : `https://console.aws.amazon.com/kms/home#/kms/keys/${ctx.attrs.keyId}`,
  facts: (ctx) => [
    { label: "key id", value: ctx.attrs?.keyId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.keyArn, mono: true, copy: true },
    { label: "spec", value: ctx.attrs?.keySpec },
    { label: "usage", value: ctx.attrs?.keyUsage },
    { label: "state", value: ctx.attrs?.keyState },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "rotation", value: ctx.attrs?.keyRotationEnabled },
    { label: "multi-region", value: ctx.attrs?.multiRegion },
  ],
});

export const AliasUI = UIProvider.succeed<Alias>("AWS.KMS.Alias", {
  displayName: "KMS Alias",
  icon: "tag",
  color: "#DD344C",
  category: "security",
  summary: (ctx) => ctx.attrs?.aliasName,
  facts: (ctx) => [
    { label: "alias", value: ctx.attrs?.aliasName, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.aliasArn, mono: true, copy: true },
    {
      label: "target key",
      value: ctx.attrs?.targetKeyId,
      mono: true,
      copy: true,
    },
  ],
});

export const ui = () => Layer.mergeAll(KeyUI, AliasUI);
