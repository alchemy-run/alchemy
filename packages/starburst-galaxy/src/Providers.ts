import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { StarburstGalaxyAuth } from "./AuthProvider.ts";
import { PostgresqlCatalog, PostgresqlCatalogProvider } from "./Catalog/PostgresqlCatalog.ts";
import { S3Catalog, S3CatalogProvider } from "./Catalog/S3Catalog.ts";
import { Cluster, ClusterProvider } from "./Cluster/Cluster.ts";
import * as Credentials from "./Credentials.ts";
import { ColumnMask, ColumnMaskProvider } from "./Governance/ColumnMask.ts";
import { RowFilter, RowFilterProvider } from "./Governance/RowFilter.ts";
import { Tag, TagProvider } from "./Governance/Tag.ts";
import { TagAssignment, TagAssignmentProvider } from "./Governance/TagAssignment.ts";
import { Role, RoleProvider } from "./Role/Role.ts";
import { RolePrivilege, RolePrivilegeProvider } from "./Role/RolePrivilege.ts";
import { ServiceAccount, ServiceAccountProvider } from "./ServiceAccount/ServiceAccount.ts";
import {
  ServiceAccountPassword,
  ServiceAccountPasswordProvider,
} from "./ServiceAccount/ServiceAccountPassword.ts";

/**
 * Service tag bundling every Starburst Galaxy provider, the AuthProvider
 * and credential resolution. Use `StarburstGalaxy.providers()` to build it.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("StarburstGalaxy") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Starburst Galaxy providers and credentials: catalogs, clusters, roles
 * and privileges, service accounts and passwords, column masks, row
 * filters and tags. Registers the Starburst Galaxy AuthProvider so
 * `alchemy profile edit` can configure it.
 *
 * @example
 * ```ts
 * Effect.provide(StarburstGalaxy.providers())
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Cluster,
      ColumnMask,
      PostgresqlCatalog,
      Role,
      RolePrivilege,
      RowFilter,
      S3Catalog,
      ServiceAccount,
      ServiceAccountPassword,
      Tag,
      TagAssignment,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ClusterProvider(),
        ColumnMaskProvider(),
        PostgresqlCatalogProvider(),
        RoleProvider(),
        RolePrivilegeProvider(),
        RowFilterProvider(),
        S3CatalogProvider(),
        ServiceAccountProvider(),
        ServiceAccountPasswordProvider(),
        TagProvider(),
        TagAssignmentProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(StarburstGalaxyAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
