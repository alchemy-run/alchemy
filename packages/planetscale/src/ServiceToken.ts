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
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
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
  | "connect_branch"
  | "connect_production_branch"
  | "delete_branch_password"
  | "delete_production_branch_password"
  | "create_deploy_request"
  | "read_deploy_request"
  | "approve_deploy_request"
  | "create_comment"
  | "read_comment"
  | "read_backups"
  | "write_backups"
  | "delete_backups"
  | "delete_production_branch_backups"
  | "restore_backup"
  | "restore_production_branch_backup"
  | "write_branch_vschema"
  | "write_production_branch_vschema";

/** Properties for a service token scoped to one PlanetScale database. */
export interface ServiceTokenProps {
  /** Name prefix. An instance suffix allows old and replacement tokens to coexist. */
  name?: string;
  /** Organization slug. Defaults to the configured PlanetScale organization. */
  organization?: string;
  /** Database name. Changing it replaces the token. */
  database: string;
  /** Exact database permissions. Permissions not declared here are revoked. */
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
 * Changing the name prefix, organization, or database creates a replacement.
 * Resources that consume the token's outputs are updated before Alchemy deletes
 * the previous token. Changes to `accesses` are reconciled in place.
 *
 * ### Creating a Database Token
 * **Example:** Read recommendations and dismiss resolved recommendations
 * ```typescript
 * const token = yield* Planetscale.ServiceToken("Recommendations", {
 *   database: "app-db",
 *   accesses: ["read_database", "write_database"],
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
    read: Effect.fn(function* ({ output }) {
      if (!output) return undefined;
      const live = yield* getToken(output.organization, output.id);
      return live ? { ...output, name: live.name ?? output.name } : undefined;
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
      const organization = org ?? (yield* yield* Credentials).organization;
      const name = yield* tokenName(id, instanceId, prefix);
      if (
        output.organization !== organization ||
        output.database !== news.database ||
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
        news.database,
        news.accesses,
      )
        ? undefined
        : ({ action: "update" } as const);
    }),
    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const organization = news.organization ?? (yield* yield* Credentials).organization;
      const name = yield* tokenName(id, instanceId, news.name);
      const observed = output ? yield* getToken(output.organization, output.id) : undefined;

      if (!observed) {
        const existing = yield* planetscale.listServiceTokens
          .items({ organization })
          .pipe(Stream.runCollect);
        if (existing.some((token) => token.name === name)) {
          return yield* new ServiceTokenError({
            message: `Service token ${name} exists without its creation-only secret in this stack's state. Recover that state or revoke the token before retrying.`,
          });
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
          yield* ensureAccess(organization, live.id, news);
          return {
            id: live.id,
            name: live.name ?? name,
            organization,
            database: news.database,
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

const tokenName = (id: string, instanceId: string, prefix: string | undefined) =>
  createPhysicalName({ id, instanceId, prefix: prefix === undefined ? undefined : `${prefix}-` });

const ordered = <A extends string>(accesses: readonly A[]) => Array.dedupe(accesses).toSorted();

const getToken = (organization: string, id: string) =>
  planetscale
    .getServiceToken({ organization, id })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

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
  news: ServiceTokenProps,
) {
  const current = (yield* planetscale.listServiceTokenAccesses({ organization, id })).data;
  for (const entry of current) {
    if (
      entry.resource.type !== "Database" ||
      entry.resource.name !== news.database ||
      !news.accesses.some((access) => access === entry.access)
    ) {
      yield* planetscale.removeServiceTokenAccess({
        organization,
        id,
        database: entry.resource.type === "Database" ? entry.resource.name : "",
        access: [entry.access],
      });
    }
  }
  const missing = ordered(news.accesses).filter(
    (access) =>
      !current.some(
        (entry) =>
          entry.resource.type === "Database" &&
          entry.resource.name === news.database &&
          entry.access === access,
      ),
  );
  if (missing.length > 0) {
    yield* planetscale.addServiceTokenAccess({
      organization,
      id,
      database: news.database,
      access: missing,
    });
  }
  if (
    !exactAccess(
      (yield* planetscale.listServiceTokenAccesses({ organization, id })).data,
      news.database,
      news.accesses,
    )
  ) {
    return yield* new ServiceTokenError({
      message: `Service token ${id} did not converge to its declared database permissions.`,
    });
  }
});
