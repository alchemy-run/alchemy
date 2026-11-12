import { isTransientError } from "@distilled.cloud/core/category";
import { Retry } from "@distilled.cloud/starburst-galaxy/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { StarburstGalaxyAuth } from "./AuthProvider.ts";
import { BigQueryCatalog, BigQueryCatalogProvider } from "./Catalog/BigQueryCatalog.ts";
import { CassandraCatalog, CassandraCatalogProvider } from "./Catalog/CassandraCatalog.ts";
import { GcsCatalog, GcsCatalogProvider } from "./Catalog/GcsCatalog.ts";
import { MongoDBCatalog, MongoDBCatalogProvider } from "./Catalog/MongoDBCatalog.ts";
import { MySQLCatalog, MySQLCatalogProvider } from "./Catalog/MySQLCatalog.ts";
import { OpenSearchCatalog, OpenSearchCatalogProvider } from "./Catalog/OpenSearchCatalog.ts";
import { PostgresqlCatalog, PostgresqlCatalogProvider } from "./Catalog/PostgresqlCatalog.ts";
import { RedshiftCatalog, RedshiftCatalogProvider } from "./Catalog/RedshiftCatalog.ts";
import { S3Catalog, S3CatalogProvider } from "./Catalog/S3Catalog.ts";
import { SnowflakeCatalog, SnowflakeCatalogProvider } from "./Catalog/SnowflakeCatalog.ts";
import { SqlServerCatalog, SqlServerCatalogProvider } from "./Catalog/SqlServerCatalog.ts";
import {
  CrossAccountIamRole,
  CrossAccountIamRoleProvider,
} from "./CloudAccess/CrossAccountIamRole.ts";
import {
  CrossAccountIamRoleTrust,
  CrossAccountIamRoleTrustProvider,
} from "./CloudAccess/CrossAccountIamRoleTrust.ts";
import { Cluster, ClusterProvider } from "./Cluster/Cluster.ts";
import * as Credentials from "./Credentials.ts";
import { DataDomain, DataDomainProvider } from "./DataProduct/DataDomain.ts";
import { ColumnMask, ColumnMaskProvider } from "./Governance/ColumnMask.ts";
import { Policy, PolicyProvider } from "./Governance/Policy.ts";
import { RowFilter, RowFilterProvider } from "./Governance/RowFilter.ts";
import { Tag, TagProvider } from "./Governance/Tag.ts";
import { TagAssignment, TagAssignmentProvider } from "./Governance/TagAssignment.ts";
import { PrivateLink, PrivateLinkProvider } from "./Network/PrivateLink.ts";
import { Role, RoleProvider } from "./Role/Role.ts";
import { RoleGrant, RoleGrantProvider } from "./Role/RoleGrant.ts";
import { RolePrivilege, RolePrivilegeProvider } from "./Role/RolePrivilege.ts";
import { ServiceAccount, ServiceAccountProvider } from "./ServiceAccount/ServiceAccount.ts";
import {
  ServiceAccountPassword,
  ServiceAccountPasswordProvider,
} from "./ServiceAccount/ServiceAccountPassword.ts";
import { SqlJob, SqlJobProvider } from "./SqlJob/SqlJob.ts";
import { Group, GroupProvider } from "./User/Group.ts";
import { User, UserProvider } from "./User/User.ts";
import { UserDefaultRole, UserDefaultRoleProvider } from "./User/UserDefaultRole.ts";

/**
 * Service tag bundling every Starburst Galaxy provider, the AuthProvider
 * and credential resolution. Use `StarburstGalaxy.providers()` to build it.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("StarburstGalaxy") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Galaxy rate-limits an account to about twenty API calls per ten
 * seconds and states the wait in its 429 (read by the SDK). Every caller
 * that was refused waits that long, plus up to five seconds of jitter so
 * they do not all return in the same window; twelve tries bound the wait
 * at about three minutes.
 */
export const RetryPolicy = Layer.succeed(Retry, {
  while: isTransientError,
  backoff: {
    baseMs: 1_000,
    factor: 2,
    capMs: 15_000,
    maxRetries: 12,
    jitterMs: 5_000,
    serverHint: true,
  },
});

/**
 * Starburst Galaxy providers and credentials: catalogs, clusters, roles and
 * privileges, service accounts and passwords, column masks, row filters,
 * tags, data domains and SQL jobs. Registers the Starburst Galaxy
 * AuthProvider so `alchemy profile edit` can configure it.
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
      BigQueryCatalog,
      CassandraCatalog,
      Cluster,
      ColumnMask,
      DataDomain,
      GcsCatalog,
      MongoDBCatalog,
      MySQLCatalog,
      OpenSearchCatalog,
      PostgresqlCatalog,
      RedshiftCatalog,
      Role,
      RolePrivilege,
      RowFilter,
      S3Catalog,
      ServiceAccount,
      ServiceAccountPassword,
      SnowflakeCatalog,
      SqlJob,
      SqlServerCatalog,
      Tag,
      TagAssignment,
      CrossAccountIamRole,
      CrossAccountIamRoleTrust,
      Group,
      Policy,
      PrivateLink,
      RoleGrant,
      User,
      UserDefaultRole,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BigQueryCatalogProvider(),
        CassandraCatalogProvider(),
        ClusterProvider(),
        ColumnMaskProvider(),
        DataDomainProvider(),
        GcsCatalogProvider(),
        MongoDBCatalogProvider(),
        MySQLCatalogProvider(),
        OpenSearchCatalogProvider(),
        PostgresqlCatalogProvider(),
        RedshiftCatalogProvider(),
        RoleProvider(),
        RolePrivilegeProvider(),
        RowFilterProvider(),
        S3CatalogProvider(),
        ServiceAccountProvider(),
        ServiceAccountPasswordProvider(),
        SnowflakeCatalogProvider(),
        SqlJobProvider(),
        SqlServerCatalogProvider(),
        TagProvider(),
        TagAssignmentProvider(),
        CrossAccountIamRoleProvider(),
        CrossAccountIamRoleTrustProvider(),
        GroupProvider(),
        PolicyProvider(),
        PrivateLinkProvider(),
        RoleGrantProvider(),
        UserProvider(),
        UserDefaultRoleProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(RetryPolicy),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(StarburstGalaxyAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
