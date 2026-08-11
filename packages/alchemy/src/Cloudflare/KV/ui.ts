import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Dashboard UI providers for Cloudflare KV resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const NamespaceUI = UIProvider.succeed<Namespace>(
  "Cloudflare.KV.Namespace",
  {
    displayName: "KV Namespace",
    icon: "key-round",
    color: "#F6821F",
    category: "storage",
    summary: (ctx) => ctx.attrs?.title,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined || ctx.attrs.namespaceId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/workers/kv/namespaces/${ctx.attrs.namespaceId}`,
    facts: (ctx) => [
      { label: "title", value: ctx.attrs?.title, copy: true },
      {
        label: "namespace id",
        value: ctx.attrs?.namespaceId,
        mono: true,
        copy: true,
      },
      { label: "url encoding", value: ctx.attrs?.supportsUrlEncoding },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(NamespaceUI);
