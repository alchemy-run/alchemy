import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountSetting } from "./AccountSetting.ts";
import type { ObservabilityDestination } from "./ObservabilityDestination.ts";
import type { WorkerRoute } from "./Route.ts";
import type { Subdomain } from "./Subdomain.ts";
import type { Worker } from "./Worker.ts";

/**
 * Dashboard UI providers for Cloudflare Workers resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 *
 * Note: DurableObject, Browser, RateLimit, VersionMetadata, and
 * WorkerLoader are `Binding.Service`s (Worker-only bindings with no
 * backing Resource), so they have no Resource tag and no UIProvider —
 * they surface on the dashboard as bindings of their host Worker.
 */
export const WorkerUI = UIProvider.succeed<Worker>("Cloudflare.Worker", {
  displayName: "Worker",
  icon: "zap",
  color: "#F6821F",
  category: "compute",
  summary: (ctx) => ctx.attrs?.workerName,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined || ctx.attrs.workerName === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/workers/services/view/${ctx.attrs.workerName}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.workerName, copy: true },
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
    { label: "namespace", value: ctx.attrs?.namespace },
    {
      label: "crons",
      value: ctx.attrs?.crons?.length ? ctx.attrs.crons.join(", ") : undefined,
      mono: true,
    },
    {
      label: "domain",
      value: ctx.attrs?.domain
        ? [ctx.attrs.domain.name, ...ctx.attrs.domain.aliases].join(", ")
        : undefined,
    },
  ],
});

export const WorkerRouteUI = UIProvider.succeed<WorkerRoute>(
  "Cloudflare.Workers.Route",
  {
    displayName: "Worker Route",
    icon: "route",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.props?.pattern,
  },
);

export const SubdomainUI = UIProvider.succeed<Subdomain>(
  "Cloudflare.Workers.Subdomain",
  {
    displayName: "Workers Subdomain",
    icon: "globe",
    color: "#F6821F",
    category: "dns",
  },
);

export const AccountSettingUI = UIProvider.succeed<AccountSetting>(
  "Cloudflare.Workers.AccountSetting",
  {
    displayName: "Workers Account Setting",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
  },
);

export const ObservabilityDestinationUI =
  UIProvider.succeed<ObservabilityDestination>(
    "Cloudflare.Workers.ObservabilityDestination",
    {
      displayName: "Observability Destination",
      icon: "satellite-dish",
      color: "#F6821F",
      category: "observability",
      summary: (ctx) => ctx.attrs?.name,
      link: (ctx) => ctx.attrs?.url,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name, copy: true },
        { label: "slug", value: ctx.attrs?.slug, mono: true, copy: true },
        {
          label: "endpoint",
          value: ctx.attrs?.url,
          href: ctx.attrs?.url,
          copy: true,
        },
        { label: "dataset", value: ctx.attrs?.logpushDataset, mono: true },
        { label: "enabled", value: ctx.attrs?.enabled },
        {
          label: "scripts",
          value: ctx.attrs?.scripts?.length
            ? ctx.attrs.scripts.join(", ")
            : undefined,
          mono: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    WorkerUI,
    WorkerRouteUI,
    SubdomainUI,
    AccountSettingUI,
    ObservabilityDestinationUI,
  );
