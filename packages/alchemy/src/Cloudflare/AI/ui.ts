import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CustomTopics } from "./CustomTopics.ts";
import type { Dataset } from "./Dataset.ts";
import type { Evaluation } from "./Evaluation.ts";
import type { Gateway } from "./Gateway.ts";
import type { GatewayDynamicRouting } from "./GatewayDynamicRouting.ts";
import type { GatewayProvider } from "./GatewayProvider.ts";
import type { SearchInstance } from "./SearchInstance.ts";
import type { SearchNamespace } from "./SearchNamespace.ts";
import type { SearchToken } from "./SearchToken.ts";
import type { SecuritySettings } from "./SecuritySettings.ts";

/**
 * Dashboard UI providers for Cloudflare AI resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const GatewayUI = UIProvider.succeed<Gateway>("Cloudflare.AI.Gateway", {
  displayName: "AI Gateway",
  icon: "waypoints",
  color: "#F6821F",
  category: "ai",
  summary: (ctx) => ctx.attrs?.gatewayId,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined || ctx.attrs?.gatewayId === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/ai/ai-gateway/gateways/${ctx.attrs.gatewayId}`,
  facts: (ctx) => [
    { label: "gateway", value: ctx.attrs?.gatewayId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "logs", value: ctx.attrs?.collectLogs },
    { label: "authentication", value: ctx.attrs?.authentication },
    {
      label: "cache ttl",
      value: ctx.attrs?.cacheTtl === null ? undefined : ctx.attrs?.cacheTtl,
    },
    {
      label: "rate limit",
      value:
        ctx.attrs?.rateLimitingLimit === null ||
        ctx.attrs?.rateLimitingLimit === undefined
          ? undefined
          : `${ctx.attrs.rateLimitingLimit} / ${ctx.attrs.rateLimitingInterval ?? "?"}s (${ctx.attrs.rateLimitingTechnique ?? ""})`,
    },
    { label: "zdr", value: ctx.attrs?.zdr },
  ],
});

export const GatewayProviderUI = UIProvider.succeed<GatewayProvider>(
  "Cloudflare.AI.GatewayProvider",
  {
    displayName: "AI Gateway Provider",
    icon: "key-round",
    color: "#F6821F",
    category: "ai",
    summary: (ctx) =>
      ctx.attrs?.providerSlug === undefined
        ? ctx.attrs?.alias
        : `${ctx.attrs.providerSlug}${ctx.attrs.alias ? ` (${ctx.attrs.alias})` : ""}`,
    facts: (ctx) => [
      { label: "provider", value: ctx.attrs?.providerSlug },
      { label: "alias", value: ctx.attrs?.alias },
      { label: "gateway", value: ctx.attrs?.gatewayId, mono: true, copy: true },
      {
        label: "config id",
        value: ctx.attrs?.providerConfigId,
        mono: true,
        copy: true,
      },
      { label: "secret", value: ctx.attrs?.secretPreview, mono: true },
      { label: "default", value: ctx.attrs?.defaultConfig },
    ],
  },
);

export const GatewayDynamicRoutingUI =
  UIProvider.succeed<GatewayDynamicRouting>("Cloudflare.AI.DynamicRouting", {
    displayName: "AI Gateway Dynamic Route",
    icon: "route",
    color: "#F6821F",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "gateway", value: ctx.attrs?.gatewayId, mono: true, copy: true },
      { label: "route id", value: ctx.attrs?.routeId, mono: true, copy: true },
      { label: "version", value: ctx.attrs?.versionId, mono: true },
      { label: "deployment", value: ctx.attrs?.deploymentId, mono: true },
      { label: "elements", value: ctx.attrs?.elements?.length },
    ],
  });

export const DatasetUI = UIProvider.succeed<Dataset>("Cloudflare.AI.Dataset", {
  displayName: "AI Gateway Dataset",
  icon: "database",
  color: "#F6821F",
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "dataset id",
      value: ctx.attrs?.datasetId,
      mono: true,
      copy: true,
    },
    { label: "gateway", value: ctx.attrs?.gatewayId, mono: true, copy: true },
    { label: "enabled", value: ctx.attrs?.enable },
    { label: "filters", value: ctx.attrs?.filters?.length },
  ],
});

export const EvaluationUI = UIProvider.succeed<Evaluation>(
  "Cloudflare.AI.Evaluation",
  {
    displayName: "AI Gateway Evaluation",
    icon: "clipboard-check",
    color: "#F6821F",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "evaluation id",
        value: ctx.attrs?.evaluationId,
        mono: true,
        copy: true,
      },
      { label: "gateway", value: ctx.attrs?.gatewayId, mono: true, copy: true },
      { label: "datasets", value: ctx.attrs?.datasetIds?.length },
      { label: "processed", value: ctx.attrs?.processed },
      { label: "total logs", value: ctx.attrs?.totalLogs },
    ],
  },
);

export const SearchInstanceUI = UIProvider.succeed<SearchInstance>(
  "Cloudflare.AI.Search",
  {
    displayName: "AI Search",
    icon: "search",
    color: "#F6821F",
    category: "ai",
    summary: (ctx) => ctx.attrs?.instanceId,
    facts: (ctx) => [
      {
        label: "instance",
        value: ctx.attrs?.instanceId,
        mono: true,
        copy: true,
      },
      { label: "namespace", value: ctx.attrs?.namespace },
      { label: "type", value: ctx.attrs?.type },
      { label: "source", value: ctx.attrs?.source, mono: true },
      { label: "embedding model", value: ctx.attrs?.embeddingModel },
      { label: "search model", value: ctx.attrs?.aiSearchModel },
      { label: "status", value: ctx.attrs?.status },
      { label: "paused", value: ctx.attrs?.paused },
    ],
  },
);

export const SearchNamespaceUI = UIProvider.succeed<SearchNamespace>(
  "Cloudflare.AI.SearchNamespace",
  {
    displayName: "AI Search Namespace",
    icon: "folder-tree",
    color: "#F6821F",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "description", value: ctx.attrs?.description },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const SearchTokenUI = UIProvider.succeed<SearchToken>(
  "Cloudflare.AI.SearchToken",
  {
    displayName: "AI Search Token",
    icon: "key-round",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "token id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "api token", value: ctx.attrs?.cfApiId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "legacy", value: ctx.attrs?.legacy },
    ],
  },
);

export const SecuritySettingsUI = UIProvider.succeed<SecuritySettings>(
  "Cloudflare.AI.SecuritySettings",
  {
    displayName: "AI Security Settings",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.enabled === undefined
        ? ctx.attrs?.zoneId
        : ctx.attrs.enabled
          ? "enabled"
          : "disabled",
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "initial", value: ctx.attrs?.initialEnabled },
    ],
  },
);

export const CustomTopicsUI = UIProvider.succeed<CustomTopics>(
  "Cloudflare.AI.Security.CustomTopics",
  {
    displayName: "AI Security Custom Topics",
    icon: "shield",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "topics", value: ctx.attrs?.topics?.length },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    GatewayUI,
    GatewayProviderUI,
    GatewayDynamicRoutingUI,
    DatasetUI,
    EvaluationUI,
    SearchInstanceUI,
    SearchNamespaceUI,
    SearchTokenUI,
    SecuritySettingsUI,
    CustomTopicsUI,
  );
