import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Branch } from "./Branch.ts";
import type { Project } from "./Project.ts";

/**
 * Dashboard UI providers for Neon resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Neon SDK code reaches the dashboard bundle.
 */
export const ProjectUI = UIProvider.succeed<Project>("Neon.Project", {
  displayName: "Neon Project",
  icon: "database",
  color: "#00E599",
  category: "database",
  summary: (ctx) => ctx.attrs?.projectName ?? ctx.attrs?.projectId,
  consoleUrl: (ctx) =>
    ctx.attrs?.projectId === undefined
      ? undefined
      : `https://console.neon.tech/app/projects/${ctx.attrs.projectId}`,
  facts: (ctx) => [
    { label: "project", value: ctx.attrs?.projectName, copy: true },
    { label: "id", value: ctx.attrs?.projectId, mono: true, copy: true },
    { label: "region", value: ctx.attrs?.region },
    {
      label: "postgres",
      value:
        ctx.attrs?.pgVersion === undefined
          ? undefined
          : `v${ctx.attrs.pgVersion}`,
    },
    { label: "default branch", value: ctx.attrs?.defaultBranchName },
    { label: "database", value: ctx.attrs?.databaseName, mono: true },
    { label: "role", value: ctx.attrs?.roleName, mono: true },
    { label: "host", value: ctx.attrs?.origin?.host, mono: true, copy: true },
  ],
});

export const BranchUI = UIProvider.succeed<Branch>("Neon.Branch", {
  displayName: "Neon Branch",
  icon: "git-branch",
  color: "#00E599",
  category: "database",
  summary: (ctx) => ctx.attrs?.branchName ?? ctx.attrs?.branchId,
  consoleUrl: (ctx) =>
    ctx.attrs?.projectId === undefined || ctx.attrs?.branchId === undefined
      ? undefined
      : `https://console.neon.tech/app/projects/${ctx.attrs.projectId}/branches/${ctx.attrs.branchId}`,
  facts: (ctx) => [
    { label: "branch", value: ctx.attrs?.branchName, copy: true },
    { label: "id", value: ctx.attrs?.branchId, mono: true, copy: true },
    { label: "project", value: ctx.attrs?.projectId, mono: true, copy: true },
    { label: "parent", value: ctx.attrs?.parentBranchId, mono: true },
    { label: "database", value: ctx.attrs?.databaseName, mono: true },
    { label: "role", value: ctx.attrs?.roleName, mono: true },
    { label: "protected", value: ctx.attrs?.protected },
    { label: "host", value: ctx.attrs?.origin?.host, mono: true, copy: true },
  ],
});

export const ui = () => Layer.mergeAll(ProjectUI, BranchUI);
