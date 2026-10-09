import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { SigningKey } from "./SigningKey.ts";
import type { Variant } from "./Variant.ts";

/**
 * Dashboard UI providers for Cloudflare Images resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const SigningKeyUI = UIProvider.succeed<SigningKey>(
  "Cloudflare.Images.SigningKey",
  {
    displayName: "Images Signing Key",
    icon: "key-round",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.keyName,
    facts: (ctx) => [
      { label: "key name", value: ctx.attrs?.keyName, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const VariantUI = UIProvider.succeed<Variant>(
  "Cloudflare.Images.Variant",
  {
    displayName: "Images Variant",
    icon: "crop",
    color: "#F6821F",
    category: "media",
    summary: (ctx) => ctx.attrs?.variantName,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/images/variants`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.variantName, mono: true, copy: true },
      { label: "fit", value: ctx.attrs?.fit },
      {
        label: "dimensions",
        value:
          ctx.attrs?.width === undefined || ctx.attrs?.height === undefined
            ? undefined
            : `${ctx.attrs.width}x${ctx.attrs.height}`,
      },
      { label: "metadata", value: ctx.attrs?.metadata },
      {
        label: "never require signed urls",
        value: ctx.attrs?.neverRequireSignedURLs,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(SigningKeyUI, VariantUI);
