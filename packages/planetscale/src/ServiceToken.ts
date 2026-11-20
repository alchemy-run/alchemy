import * as planetscale from "@distilled.cloud/planetscale";
import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type { MySQLDatabase } from "./MySQL/MySQLDatabase.ts";
import type { PostgresDatabase } from "./Postgres/PostgresDatabase.ts";
import type { Providers } from "./Providers.ts";

/** Database permissions supported by PlanetScale service tokens. */
export type ServiceTokenDatabaseAccess =
  | "read_database"
  | "write_database"
  | "delete_database"
  | "create_branch"
  | "read_branch"
  | "delete_branch"
  | "delete_production_branch"
  | "promote_branches"
  | "demote_branches"
  | "connect_branch"
  | "connect_production_branch"
  | "connect_production_read_only_branch"
  | "create_branch_password"
  | "create_production_branch_password"
  | "create_production_read_only_branch_password"
  | "delete_branch_password"
  | "delete_production_branch_password"
  | "delete_production_read_only_branch_password"
  | "create_deploy_request"
  | "read_deploy_request"
  | "approve_deploy_request"
  | "review_deploy_request"
  | "create_comment"
  | "read_comment"
  | "read_backups"
  | "write_backups"
  | "delete_backups"
  | "delete_production_branch_backups"
  | "restore_backup"
  | "restore_production_branch_backup"
  | "write_branch_vschema"
  | "write_production_branch_vschema"
  | "write_branch_topology"
  | "write_production_branch_topology"
  | "read_workflow"
  | "write_workflow"
  | "delete_workflow";

/** Properties for a service token scoped to one PlanetScale database. */
export interface ServiceTokenProps {
  /** Name prefix. An instance suffix allows old and replacement tokens to coexist. */
  name?: string;
  /**
   * Organization slug. Defaults to the database resource's organization, then
   * to the configured PlanetScale organization.
   */
  organization?: string;
  /**
   * The database the token is scoped to: its name, a {@link MySQLDatabase} or
   * {@link PostgresDatabase} resource, or a `.ref(...)` to one deployed
   * elsewhere. Changing it replaces the token.
   */
  database: string | MySQLDatabase | PostgresDatabase;
  /**
   * Exact database permissions. Permissions not declared here are revoked.
   * PlanetScale also accepts the Vitess-only accesses (`*_vschema`,
   * `*_topology`, `*_workflow`) on a Postgres database.
   */
  accesses: readonly ServiceTokenDatabaseAccess[];
}

/** Output attributes of a deployed PlanetScale service token. */
export interface ServiceTokenAttributes {
  /** Service token ID. */
  id: string;
  /** Physical token name, including the instance suffix. */
  name: string;
  /** Organization that owns the token. */
  organization: string;
  /** Database to which the token is scoped. */
  database: string;
  /** Granted database permissions. */
  accesses: readonly ServiceTokenDatabaseAccess[];
  /** Creation-only secret, retained in Alchemy state for subsequent deploys. */
  token: Redacted.Redacted<string>;
}

export type ServiceToken = Resource<
  "Planetscale.ServiceToken",
  ServiceTokenProps,
  ServiceTokenAttributes,
  never,
  Providers
>;

/**
 * A PlanetScale API service token with exactly the declared permissions on one database.
 *
 * The deployment identity must be allowed to create service tokens and manage
 * their accesses. These API credentials are separate from database passwords.
 *
 * PlanetScale returns the secret only at creation. Alchemy preserves it in
 * state; use a state backend that protects secrets. Existing tokens cannot be
 * adopted because their secret cannot be recovered.
 *
 * Service tokens carry no labels or tags, so a token's physical name, which
 * holds this resource's instance ID, is its only ownership marker. If a
 * create is interrupted before Alchemy saves the token, the next destroy
 * finds it by that name and revokes it, and the next deploy revokes it and
 * mints a replacement, since its secret was never saved. `list` returns
 * nothing: a name alone can't prove which stack made a token, and listing
 * every token would offer an organization's other tokens to account-wide
 * cleanup.
 *
 * Changing the name prefix, organization, or database creates a replacement.
 * Resources that consume the token's outputs are updated before Alchemy deletes
 * the previous token. Changes to `accesses` are reconciled in place.
 *
 * ### Creating a Database Token
 * **Example:** Token for a database declared in the stack
 * ```typescript
 * const database = yield* Planetscale.MySQLDatabase("Database", {
 *   clusterSize: "PS_10",
 * });
 *
 * const token = yield* Planetscale.ServiceToken("Sync", {
 *   database,
 *   accesses: ["read_database", "write_database"],
 * });
 * ```
 *
 * **Example:** Token for a Postgres database
 * ```typescript
 * const database = yield* Planetscale.PostgresDatabase("Database", {
 *   clusterSize: "PS_10",
 * });
 *
 * const token = yield* Planetscale.ServiceToken("Backups", {
 *   database,
 *   accesses: ["read_backups", "write_backups"],
 * });
 * ```
 *
 * **Example:** Token for an existing database by name
 * ```typescript
 * const token = yield* Planetscale.ServiceToken("Sync", {
 *   database: "app-db",
 *   accesses: ["read_database"],
 * });
 * ```
 *
 * ### Referencing a Database from Another Stack
 * **Example:** Token for a database another stack owns
 * ```typescript
 * const database = yield* Planetscale.MySQLDatabase.ref("Database", {
 *   stack: "shared-data",
 * });
 *
 * const token = yield* Planetscale.ServiceToken("Sync", {
 *   database,
 *   accesses: ["read_deploy_request", "create_deploy_request"],
 * });
 * ```
 *
 * ### Rotating a Token
 * **Example:** Rename the token to mint a replacement
 * ```typescript
 * // Changing `name` creates a new token; consumers are updated
 * // before the previous token is revoked.
 * const token = yield* Planetscale.ServiceToken("Sync", {
 *   name: "sync-2026-11",
 *   database,
 *   accesses: ["read_database"],
 * });
 * ```
 *
 * @resource
 */
export const ServiceToken = Resource<ServiceToken>("Planetscale.ServiceToken");

/** A service token cannot satisfy the declared ownership or access contract. */
export class ServiceTokenError extends Data.TaggedError("ServiceTokenError")<{
  readonly message: string;
}> {}

export const ServiceTokenProvider = () =>
  Provider.succeed(ServiceToken, {
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      if (output) {
        const live = yield* getToken(output.organization, output.id);
        return live ? { ...output, name: live.name ?? output.name } : undefined;
      }
      // An interrupted create leaves a token whose attributes were never
      // saved. Its physical name ends with this instance's suffix, whatever
      // prefix it was made with, so it is this resource's own: report it,
      // with an empty placeholder for the secret that was lost, so destroy
      // can revoke it.
      if (!olds) return undefined;
      const organization = yield* organizationOf(olds);
      const [live] = yield* instanceTokens(organization, id, instanceId);
      return live
        ? {
            id: live.id,
            name: live.name,
            organization,
            database: databaseName(olds.database),
            accesses: ordered(olds.accesses),
            token: Redacted.make(""),
          }
        : undefined;
    }),
    diff: Effect.fn(function* ({ id, instanceId, olds, news, output }) {
      if (!output) return undefined;
      const prefix = "name" in news ? news.name : undefined;
      const org = "organization" in news ? news.organization : undefined;
      // A computed identity can resolve to a different database after apply.
      // Replace first so a failed dependent update keeps the old token usable.
      if (
        !("database" in news) ||
        !isResolved(news.database) ||
        !isResolved(prefix) ||
        !isResolved(org)
      ) {
        return { action: "replace" } as const;
      }
      const organization =
        org ?? databaseOrganization(news.database) ?? (yield* yield* Credentials).organization;
      const database = databaseName(news.database);
      const name = yield* tokenName(id, instanceId, prefix);
      if (
        output.organization !== organization ||
        output.database !== database ||
        output.name !== name ||
        (olds && olds.name !== prefix)
      ) {
        return { action: "replace" } as const;
      }
      const live = yield* getToken(output.organization, output.id);
      if (!live || live.name !== name) return { action: "replace" } as const;
      if (!("accesses" in news) || !isResolved(news.accesses)) {
        return { action: "update" } as const;
      }
      return exactAccess(
        (yield* planetscale.listServiceTokenAccesses({ organization, id: output.id })).data,
        database,
        news.accesses,
      )
        ? undefined
        : ({ action: "update" } as const);
    }),
    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const organization = yield* organizationOf(news);
      const database = databaseName(news.database);
      const name = yield* tokenName(id, instanceId, news.name);
      let observed = output ? yield* getToken(output.organization, output.id) : undefined;

      // A live token whose secret was never saved can't reach its consumers,
      // who never received it either: revoke it and mint a replacement.
      if (observed && output && Redacted.value(output.token) === "") {
        yield* deleteToken(output.organization, output.id);
        observed = undefined;
      } else if (!observed) {
        for (const orphan of yield* instanceTokens(organization, id, instanceId)) {
          yield* deleteToken(organization, orphan.id);
        }
      }

      return yield* Effect.acquireUseRelease(
        observed
          ? Effect.succeed(observed)
          : planetscale
              .createServiceToken({ organization, name })
              // A retried create can lose the only response containing the secret.
              .pipe(planetscale.Retry.none),
        Effect.fn(function* (live) {
          const token = observed ? output?.token : live.token;
          if (!token) {
            return yield* new ServiceTokenError({
              message: `The creation-only secret for service token ${live.id} is unavailable.`,
            });
          }
          yield* ensureAccess(organization, live.id, database, news.accesses);
          return {
            id: live.id,
            name: live.name ?? name,
            organization,
            database,
            accesses: ordered(news.accesses),
            token,
          };
        }),
        (live, exit) =>
          !observed && Exit.isFailure(exit) ? deleteToken(organization, live.id) : Effect.void,
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteToken(output.organization, output.id);
    }),
  });

// Resource references in props reach the provider as the database's
// attributes, so a database prop is either a name or `{ name, organization }`.
type DatabaseInput = string | { readonly name: string; readonly organization?: string };

const databaseName = (database: ServiceTokenProps["database"]) => {
  const input = database as unknown as DatabaseInput;
  return typeof input === "string" ? input : input.name;
};

const databaseOrganization = (database: ServiceTokenProps["database"]) => {
  const input = database as unknown as DatabaseInput;
  return typeof input === "string" ? undefined : input.organization;
};

const organizationOf = Effect.fnUntraced(function* (props: ServiceTokenProps) {
  return (
    props.organization ??
    databaseOrganization(props.database) ??
    (yield* yield* Credentials).organization
  );
});

const tokenName = (id: string, instanceId: string, prefix: string | undefined) =>
  createPhysicalName({ id, instanceId, prefix: prefix === undefined ? undefined : `${prefix}-` });

const ordered = <A extends string>(accesses: readonly A[]) => Array.dedupe(accesses).toSorted();

const getToken = (organization: string, id: string) =>
  planetscale
    .getServiceToken({ organization, id })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * The organization's tokens made by this resource instance: their names end
 * with its 80-bit instance suffix, whatever prefix each was made with (a
 * truncated name keeps the suffix last, after a hash, with no delimiter).
 */
const instanceTokens = Effect.fnUntraced(function* (
  organization: string,
  id: string,
  instanceId: string,
) {
  const suffix = yield* createPhysicalName({ id, instanceId, prefix: "" });
  return yield* planetscale.listServiceTokens.items({ organization }).pipe(
    Stream.runCollect,
    Effect.map((tokens) =>
      Array.fromIterable(tokens).flatMap(({ id, name }) =>
        name?.endsWith(suffix) ? [{ id, name }] : [],
      ),
    ),
  );
});

const deleteToken = (organization: string, id: string) =>
  planetscale
    .deleteServiceToken({ organization, id })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

const exactAccess = (
  current: planetscale.ListServiceTokenAccessesOutput["data"],
  database: string,
  desired: readonly string[],
) =>
  current.length === ordered(desired).length &&
  desired.every((access) => current.some((entry) => entry.access === access)) &&
  current.every(
    (entry) =>
      entry.resource.type === "Database" &&
      entry.resource.name === database &&
      desired.includes(entry.access),
  );

const ensureAccess = Effect.fn(function* (
  organization: string,
  id: string,
  database: string,
  accesses: readonly ServiceTokenDatabaseAccess[],
) {
  const current = (yield* planetscale.listServiceTokenAccesses({ organization, id })).data;
  for (const entry of current) {
    if (
      entry.resource.type !== "Database" ||
      entry.resource.name !== database ||
      !accesses.some((access) => access === entry.access)
    ) {
      yield* planetscale.removeServiceTokenAccess({
        organization,
        id,
        database: entry.resource.type === "Database" ? entry.resource.name : "",
        access: [entry.access],
      });
    }
  }
  const missing = ordered(accesses).filter(
    (access) =>
      !current.some(
        (entry) =>
          entry.resource.type === "Database" &&
          entry.resource.name === database &&
          entry.access === access,
      ),
  );
  if (missing.length > 0) {
    yield* planetscale.addServiceTokenAccess({
      organization,
      id,
      database: database,
      access: missing,
    });
  }
  if (
    !exactAccess(
      (yield* planetscale.listServiceTokenAccesses({ organization, id })).data,
      database,
      accesses,
    )
  ) {
    return yield* new ServiceTokenError({
      message: `Service token ${id} did not converge to its declared database permissions.`,
    });
  }
});
