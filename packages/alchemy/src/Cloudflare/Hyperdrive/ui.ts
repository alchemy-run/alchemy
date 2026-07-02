import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Connection } from "./Connection.ts";

/**
 * Dashboard UI providers for Cloudflare Hyperdrive resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ConnectionUI = UIProvider.succeed<Connection>(
  "Cloudflare.Hyperdrive",
  {
    displayName: "Hyperdrive",
    icon: "plug-zap",
    color: "#F6821F",
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined || ctx.attrs.hyperdriveId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/hyperdrive/configs/${ctx.attrs.hyperdriveId}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "hyperdrive id",
        value: ctx.attrs?.hyperdriveId,
        mono: true,
        copy: true,
      },
      { label: "scheme", value: ctx.attrs?.origin?.scheme },
      { label: "host", value: ctx.attrs?.origin?.host, mono: true },
      { label: "database", value: ctx.attrs?.origin?.database, mono: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(ConnectionUI);
