import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DispatchNamespace } from "./DispatchNamespace.ts";

/**
 * Dashboard UI providers for Cloudflare Workers for Platforms resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const DispatchNamespaceUI = UIProvider.succeed<DispatchNamespace>(
  "Cloudflare.Workers.DispatchNamespace",
  {
    displayName: "Dispatch Namespace",
    icon: "layers",
    color: "#F6821F",
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/workers-for-platforms`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.namespaceId, mono: true, copy: true },
      { label: "scripts", value: ctx.attrs?.scriptCount },
      { label: "trusted", value: ctx.attrs?.trustedWorkers },
      { label: "created", value: ctx.attrs?.createdOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(DispatchNamespaceUI);
