import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Secret } from "./Secret.ts";
import type { Store } from "./SecretsStore.ts";

/**
 * Dashboard UI providers for Cloudflare Secrets Store resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const StoreUI = UIProvider.succeed<Store>("Cloudflare.SecretsStore", {
  displayName: "Secrets Store",
  icon: "vault",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.storeName,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/secrets-store`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.storeName, copy: true },
    { label: "store id", value: ctx.attrs?.storeId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
  ],
});

export const SecretUI = UIProvider.succeed<Secret>(
  "Cloudflare.SecretsStore.Secret",
  {
    displayName: "Store Secret",
    icon: "key-round",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.secretName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.secretName, copy: true },
      {
        label: "secret id",
        value: ctx.attrs?.secretId,
        mono: true,
        copy: true,
      },
      { label: "store", value: ctx.attrs?.storeId, mono: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "scopes",
        value: ctx.attrs?.scopes?.length
          ? ctx.attrs.scopes.join(", ")
          : undefined,
      },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const ui = () => Layer.mergeAll(StoreUI, SecretUI);
