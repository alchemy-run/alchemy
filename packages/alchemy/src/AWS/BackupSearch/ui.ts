import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ExportJob } from "./ExportJob.ts";
import type { SearchJob } from "./SearchJob.ts";

/**
 * Dashboard UI providers for AWS BackupSearch resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const SearchJobUI = UIProvider.succeed<SearchJob>(
  "AWS.BackupSearch.SearchJob",
  {
    displayName: "Backup Search Job",
    icon: "search",
    color: "#7AA116",
    category: "storage",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.searchJobIdentifier,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.searchJobArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ExportJobUI = UIProvider.succeed<ExportJob>(
  "AWS.BackupSearch.ExportJob",
  {
    displayName: "Backup Search Export Job",
    icon: "download",
    color: "#7AA116",
    category: "storage",
    summary: (ctx) => ctx.attrs?.exportJobIdentifier,
    facts: (ctx) => [
      {
        label: "id",
        value: ctx.attrs?.exportJobIdentifier,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.exportJobArn,
        mono: true,
        copy: true,
      },
      {
        label: "search job",
        value: ctx.attrs?.searchJobArn,
        mono: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () => Layer.mergeAll(SearchJobUI, ExportJobUI);
