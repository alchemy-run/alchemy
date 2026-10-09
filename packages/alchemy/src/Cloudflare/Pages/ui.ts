import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Deployment } from "./Deployment.ts";
import type { Domain } from "./Domain.ts";
import type { Project } from "./Project.ts";

/**
 * Dashboard UI providers for Cloudflare Pages resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ProjectUI = UIProvider.succeed<Project>(
  "Cloudflare.Pages.Project",
  {
    displayName: "Pages Project",
    icon: "panels-top-left",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) =>
      ctx.attrs?.subdomain === undefined
        ? undefined
        : `https://${ctx.attrs.subdomain}`,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined || ctx.attrs.name === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/pages/view/${ctx.attrs.name}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.projectId, mono: true, copy: true },
      {
        label: "subdomain",
        value: ctx.attrs?.subdomain,
        href:
          ctx.attrs?.subdomain === undefined
            ? undefined
            : `https://${ctx.attrs.subdomain}`,
        copy: true,
      },
      { label: "production branch", value: ctx.attrs?.productionBranch },
      {
        label: "domains",
        value: ctx.attrs?.domains?.length
          ? ctx.attrs.domains.join(", ")
          : undefined,
      },
      { label: "created", value: ctx.attrs?.createdOn },
    ],
  },
);

export const DeploymentUI = UIProvider.succeed<Deployment>(
  "Cloudflare.Pages.Deployment",
  {
    displayName: "Pages Deployment",
    icon: "rocket",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) => ctx.attrs?.shortId ?? ctx.props?.projectName,
    link: (ctx) => ctx.attrs?.url,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined ||
      ctx.attrs.projectName === undefined ||
      ctx.attrs.deploymentId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/pages/view/${ctx.attrs.projectName}/${ctx.attrs.deploymentId}`,
    facts: (ctx) => [
      { label: "project", value: ctx.attrs?.projectName },
      { label: "id", value: ctx.attrs?.deploymentId, mono: true, copy: true },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        copy: true,
      },
      { label: "environment", value: ctx.attrs?.environment },
      { label: "branch", value: ctx.attrs?.branch, mono: true },
      {
        label: "stage",
        value:
          ctx.attrs?.latestStageName === undefined
            ? undefined
            : `${ctx.attrs.latestStageName} (${ctx.attrs.latestStageStatus})`,
      },
      { label: "created", value: ctx.attrs?.createdOn },
    ],
  },
);

export const DomainUI = UIProvider.succeed<Domain>("Cloudflare.Pages.Domain", {
  displayName: "Pages Domain",
  icon: "globe",
  color: "#F6821F",
  category: "dns",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  link: (ctx) =>
    ctx.attrs?.name === undefined ? undefined : `https://${ctx.attrs.name}`,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined || ctx.attrs.projectName === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/pages/view/${ctx.attrs.projectName}/domains`,
  facts: (ctx) => [
    { label: "domain", value: ctx.attrs?.name, copy: true },
    { label: "project", value: ctx.attrs?.projectName },
    { label: "id", value: ctx.attrs?.domainId, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "validation", value: ctx.attrs?.validationStatus },
    { label: "certificate authority", value: ctx.attrs?.certificateAuthority },
    { label: "zone", value: ctx.attrs?.zoneTag, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(ProjectUI, DeploymentUI, DomainUI);
