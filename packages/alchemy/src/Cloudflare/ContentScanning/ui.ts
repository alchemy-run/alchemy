import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ContentScanning } from "./ContentScanning.ts";
import type { Expression } from "./Expression.ts";

/**
 * Dashboard UI providers for Cloudflare Content Scanning resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ContentScanningUI = UIProvider.succeed<ContentScanning>(
  "Cloudflare.ContentScanning.ContentScanning",
  {
    displayName: "Content Scanning",
    icon: "scan-search",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.enabled === undefined
        ? (ctx.attrs?.zoneId ?? ctx.props?.zoneId)
        : ctx.attrs.enabled
          ? "enabled"
          : "disabled",
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "modified", value: ctx.attrs?.modified },
    ],
  },
);

export const ExpressionUI = UIProvider.succeed<Expression>(
  "Cloudflare.ContentScanning.Expression",
  {
    displayName: "Content Scanning Expression",
    icon: "file-search",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.payload ?? ctx.props?.payload,
    facts: (ctx) => [
      { label: "payload", value: ctx.attrs?.payload, mono: true },
      { label: "id", value: ctx.attrs?.expressionId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(ContentScanningUI, ExpressionUI);
