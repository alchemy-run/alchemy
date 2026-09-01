import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { MySQLBranch } from "./MySQL/MySQLBranch.ts";
import type { MySQLDatabase } from "./MySQL/MySQLDatabase.ts";
import type { MySQLPassword } from "./MySQL/MySQLPassword.ts";
import type { PostgresBranch } from "./Postgres/PostgresBranch.ts";
import type { PostgresDatabase } from "./Postgres/PostgresDatabase.ts";
import type { PostgresDefaultRole } from "./Postgres/PostgresDefaultRole.ts";
import type { PostgresRole } from "./Postgres/PostgresRole.ts";

/**
 * Dashboard UI providers for PlanetScale resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no SDK code reaches the dashboard bundle.
 */

const PLANETSCALE_ORANGE = "#f97316";

export const MySQLDatabaseUI = UIProvider.succeed<MySQLDatabase>(
  "Planetscale.MySQLDatabase",
  {
    displayName: "PlanetScale MySQL Database",
    icon: "database",
    color: PLANETSCALE_ORANGE,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => ctx.attrs?.htmlUrl,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "organization", value: ctx.attrs?.organization },
      { label: "region", value: ctx.attrs?.region?.slug },
      { label: "plan", value: ctx.attrs?.plan },
      { label: "cluster size", value: ctx.attrs?.clusterSize },
      { label: "default branch", value: ctx.attrs?.defaultBranch },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const MySQLBranchUI = UIProvider.succeed<MySQLBranch>(
  "Planetscale.MySQLBranch",
  {
    displayName: "PlanetScale MySQL Branch",
    icon: "git-branch",
    color: PLANETSCALE_ORANGE,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => ctx.attrs?.htmlUrl,
    facts: (ctx) => [
      { label: "branch", value: ctx.attrs?.name, copy: true },
      { label: "database", value: ctx.attrs?.database },
      { label: "organization", value: ctx.attrs?.organization },
      { label: "parent branch", value: ctx.attrs?.parentBranch },
      { label: "production", value: ctx.attrs?.production },
      { label: "region", value: ctx.attrs?.region?.slug },
    ],
  },
);

export const MySQLPasswordUI = UIProvider.succeed<MySQLPassword>(
  "Planetscale.MySQLPassword",
  {
    displayName: "PlanetScale MySQL Password",
    icon: "key-round",
    color: PLANETSCALE_ORANGE,
    category: "auth",
    summary: (ctx) => ctx.attrs?.username ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "username", value: ctx.attrs?.username, mono: true, copy: true },
      { label: "host", value: ctx.attrs?.host, mono: true, copy: true },
      { label: "database", value: ctx.attrs?.database },
      { label: "branch", value: ctx.attrs?.branch },
      { label: "role", value: ctx.attrs?.role },
      { label: "expires", value: ctx.attrs?.expiresAt ?? undefined },
    ],
  },
);

export const PostgresDatabaseUI = UIProvider.succeed<PostgresDatabase>(
  "Planetscale.PostgresDatabase",
  {
    displayName: "PlanetScale Postgres Database",
    icon: "database",
    color: PLANETSCALE_ORANGE,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => ctx.attrs?.htmlUrl,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "organization", value: ctx.attrs?.organization },
      { label: "region", value: ctx.attrs?.region?.slug },
      { label: "plan", value: ctx.attrs?.plan },
      { label: "cluster size", value: ctx.attrs?.clusterSize },
      { label: "arch", value: ctx.attrs?.arch },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const PostgresBranchUI = UIProvider.succeed<PostgresBranch>(
  "Planetscale.PostgresBranch",
  {
    displayName: "PlanetScale Postgres Branch",
    icon: "git-branch",
    color: PLANETSCALE_ORANGE,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) => ctx.attrs?.htmlUrl,
    facts: (ctx) => [
      { label: "branch", value: ctx.attrs?.name, copy: true },
      { label: "database", value: ctx.attrs?.database },
      { label: "organization", value: ctx.attrs?.organization },
      { label: "parent branch", value: ctx.attrs?.parentBranch },
      { label: "production", value: ctx.attrs?.production },
      { label: "region", value: ctx.attrs?.region?.slug },
    ],
  },
);

export const PostgresRoleUI = UIProvider.succeed<PostgresRole>(
  "Planetscale.PostgresRole",
  {
    displayName: "PlanetScale Postgres Role",
    icon: "key-round",
    color: PLANETSCALE_ORANGE,
    category: "auth",
    summary: (ctx) => ctx.attrs?.username ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "username", value: ctx.attrs?.username, mono: true, copy: true },
      { label: "host", value: ctx.attrs?.host, mono: true, copy: true },
      {
        label: "database",
        value: ctx.attrs?.databaseName ?? ctx.attrs?.database,
      },
      { label: "branch", value: ctx.attrs?.branch },
      { label: "expires", value: ctx.attrs?.expiresAt ?? undefined },
    ],
  },
);

export const PostgresDefaultRoleUI = UIProvider.succeed<PostgresDefaultRole>(
  "Planetscale.PostgresDefaultRole",
  {
    displayName: "PlanetScale Postgres Default Role",
    icon: "user-round",
    color: PLANETSCALE_ORANGE,
    category: "auth",
    summary: (ctx) => ctx.attrs?.username ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "username", value: ctx.attrs?.username, mono: true, copy: true },
      { label: "host", value: ctx.attrs?.host, mono: true, copy: true },
      {
        label: "database",
        value: ctx.attrs?.databaseName ?? ctx.attrs?.database,
      },
      { label: "branch", value: ctx.attrs?.branch },
      { label: "expires", value: ctx.attrs?.expiresAt ?? undefined },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    MySQLDatabaseUI,
    MySQLBranchUI,
    MySQLPasswordUI,
    PostgresDatabaseUI,
    PostgresBranchUI,
    PostgresRoleUI,
    PostgresDefaultRoleUI,
  );
