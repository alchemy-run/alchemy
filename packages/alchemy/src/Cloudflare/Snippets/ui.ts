import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Snippet } from "./Snippet.ts";
import type { SnippetRules } from "./SnippetRules.ts";

/**
 * Dashboard UI providers for Cloudflare Snippets resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const SnippetUI = UIProvider.succeed<Snippet>(
  "Cloudflare.Snippets.Snippet",
  {
    displayName: "Snippet",
    icon: "code",
    color: "#F6821F",
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "main module", value: ctx.attrs?.mainModule, mono: true },
      { label: "created", value: ctx.attrs?.createdOn, mono: true },
      { label: "modified", value: ctx.attrs?.modifiedOn, mono: true },
    ],
  },
);

export const SnippetRulesUI = UIProvider.succeed<SnippetRules>(
  "Cloudflare.Snippets.Rules",
  {
    displayName: "Snippet Rules",
    icon: "list-ordered",
    color: "#F6821F",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.rules === undefined
        ? ctx.attrs?.zoneId
        : `${ctx.attrs.rules.length} rule${ctx.attrs.rules.length === 1 ? "" : "s"}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "rules", value: ctx.attrs?.rules?.length },
      {
        label: "snippets",
        value: ctx.attrs?.rules
          ?.map((r) => r?.snippetName)
          .filter((n) => n !== undefined)
          .join(", "),
        mono: true,
      },
      {
        label: "enabled rules",
        value: ctx.attrs?.rules?.filter((r) => r?.enabled).length,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(SnippetUI, SnippetRulesUI);
