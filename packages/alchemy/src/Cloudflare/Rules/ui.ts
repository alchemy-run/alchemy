import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { List } from "./List.ts";

/**
 * Dashboard UI providers for Cloudflare Rules resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ListUI = UIProvider.succeed<List>("Cloudflare.Rules.List", {
  displayName: "Rules List",
  icon: "list-ordered",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
    { label: "list id", value: ctx.attrs?.listId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "kind", value: ctx.attrs?.kind },
    { label: "items", value: ctx.attrs?.numItems },
    { label: "referencing filters", value: ctx.attrs?.numReferencingFilters },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const ui = () => Layer.mergeAll(ListUI);
