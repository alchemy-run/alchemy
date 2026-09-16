import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Database } from "./Database.ts";

/**
 * Dashboard UI providers for Cloudflare D1 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const DatabaseUI = UIProvider.succeed<Database>(
  "Cloudflare.D1Database",
  {
    displayName: "D1 Database",
    icon: "database",
    color: "#F6821F",
    category: "database",
    summary: (ctx) => ctx.attrs?.databaseName,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined || ctx.attrs.databaseId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/workers/d1/databases/${ctx.attrs.databaseId}`,
    facts: (ctx) => [
      { label: "database", value: ctx.attrs?.databaseName, copy: true },
      {
        label: "database id",
        value: ctx.attrs?.databaseId,
        mono: true,
        copy: true,
      },
      { label: "jurisdiction", value: ctx.attrs?.jurisdiction },
      {
        label: "read replication",
        value: ctx.attrs?.readReplication?.mode,
      },
      { label: "migrations dir", value: ctx.attrs?.migrationsDir, mono: true },
      {
        label: "migrations table",
        value: ctx.attrs?.migrationsTable,
        mono: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(DatabaseUI);
