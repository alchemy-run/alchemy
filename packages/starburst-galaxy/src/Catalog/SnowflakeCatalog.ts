import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateSnowflakeCatalogRequest,
  SnowflakeCatalog as SnowflakeCatalogShape,
  UpdateSnowflakeCatalogRequest,
} from "@distilled.cloud/starburst-galaxy/catalog";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { changedFields, hasChanges } from "../internal.ts";
import type { Providers } from "../Providers.ts";
import {
  type CatalogBaseAttributes,
  type CatalogBaseProps,
  catalogLifecycle,
  type CloudKind,
  secretValue,
} from "./CatalogKind.ts";
import type { CatalogLookup } from "./PostgresqlCatalog.ts";

/** Sign in with the user's password. */
export interface SnowflakePasswordAuth {
  readonly type: "password";
  /** Password of the Snowflake user. Galaxy never returns it. */
  readonly password: Redacted.Redacted<string>;
}

/** Sign in with key-pair authentication. */
export interface SnowflakeKeyAuth {
  readonly type: "key";
  /** PEM private key registered on the Snowflake user (plain or base64). Galaxy never returns it. */
  readonly privateKey: Redacted.Redacted<string>;
  /** Passphrase of an encrypted `privateKey`. */
  readonly privateKeyPassphrase?: Redacted.Redacted<string>;
}

export type SnowflakeAuth = SnowflakePasswordAuth | SnowflakeKeyAuth;

export interface SnowflakeCatalogProps extends CatalogBaseProps {
  /** Snowflake account identifier, e.g. `myorg-myaccount` or `xy12345.us-east-1`. */
  readonly accountIdentifier: string;
  /** Database Galaxy exposes as the catalog's schemas and tables. */
  readonly databaseName: string;
  /** Snowflake user Galaxy connects as. */
  readonly username: string;
  /**
   * How Galaxy signs in as `username`. Secrets are sent when their value
   * changes; switching the type updates the catalog in place.
   */
  readonly auth: SnowflakeAuth;
  /** Warehouse that runs Galaxy's queries; the user's default warehouse when unset. */
  readonly warehouse?: string;
  /** Snowflake role Galaxy uses; the user's default role when unset. */
  readonly role?: string;
  /**
   * Cloud the Snowflake account runs in, for Galaxy's network routing.
   * @default "AWS"
   */
  readonly cloudKind?: CloudKind;
}

export interface SnowflakeCatalogAttributes extends CatalogBaseAttributes {
  /** Snowflake account identifier. */
  readonly accountIdentifier: string;
  /** Database exposed by the catalog. */
  readonly databaseName: string;
  /** Snowflake user Galaxy connects as. */
  readonly username: string;
  /** How Galaxy signs in: `password` or `key`. */
  readonly authenticationType: string | undefined;
  /** Warehouse that runs Galaxy's queries, if set. */
  readonly warehouse: string | undefined;
  /** Snowflake role Galaxy uses, if set. */
  readonly role: string | undefined;
  /** Cloud the account runs in, as Galaxy reports it. */
  readonly cloudKind: CloudKind | undefined;
}

export type SnowflakeCatalog = Resource<
  "StarburstGalaxy.SnowflakeCatalog",
  SnowflakeCatalogProps,
  SnowflakeCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over a Snowflake database: its schemas and
 * tables become `<catalog>.<schema>.<table>` on every cluster the catalog
 * is attached to, so Snowflake data joins with the rest of the lakehouse.
 *
 * Every setting, the name included, updates in place. Galaxy never returns
 * the password or private key, so a rotated secret is detected by
 * comparing the deployed value with the new one. Galaxy checks the
 * connection on every create and update; set `validate: false` to store a
 * catalog it cannot check yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/snowflake.html
 *
 * ### Creating a catalog
 * **Example:** Password authentication
 * ```typescript
 * const password = yield* Config.Redacted("SNOWFLAKE_PASSWORD");
 * const sf = yield* StarburstGalaxy.SnowflakeCatalog("Finance", {
 *   accountIdentifier: "myorg-finance",
 *   databaseName: "FINANCE",
 *   username: "GALAXY",
 *   auth: { type: "password", password },
 *   warehouse: "COMPUTE_WH",
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [sf.catalogId],
 * });
 * ```
 *
 * ### Key-pair authentication
 * **Example:** An encrypted private key registered on the Snowflake user
 * ```typescript
 * const privateKey = yield* Config.Redacted("SNOWFLAKE_PRIVATE_KEY");
 * const privateKeyPassphrase = yield* Config.Redacted("SNOWFLAKE_KEY_PASSPHRASE");
 * yield* StarburstGalaxy.SnowflakeCatalog("Finance", {
 *   accountIdentifier: "myorg-finance",
 *   databaseName: "FINANCE",
 *   username: "GALAXY",
 *   auth: { type: "key", privateKey, privateKeyPassphrase },
 *   role: "ANALYST",
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const finance = StarburstGalaxy.SnowflakeCatalog.lookup({ name: "finance" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const SnowflakeCatalog = Resource<SnowflakeCatalog>("StarburstGalaxy.SnowflakeCatalog");

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: SnowflakeCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  cloudKind: props.cloudKind,
  accountIdentifier: props.accountIdentifier,
  databaseName: props.databaseName,
  username: props.username,
  authenticationType: props.auth.type,
  warehouse: props.warehouse,
  role: props.role,
});

const secretsOf = (auth: SnowflakeAuth) =>
  auth.type === "password"
    ? { password: auth.password }
    : { privateKey: auth.privateKey, privateKeyPassphrase: auth.privateKeyPassphrase };

const secretsDiffer = (olds: SnowflakeAuth, news: SnowflakeAuth) =>
  olds.type !== news.type ||
  (olds.type === "password" && news.type === "password"
    ? secretValue(olds.password) !== secretValue(news.password)
    : olds.type === "key" &&
      news.type === "key" &&
      (secretValue(olds.privateKey) !== secretValue(news.privateKey) ||
        secretValue(olds.privateKeyPassphrase) !== secretValue(news.privateKeyPassphrase)));

export const SnowflakeCatalogProvider = () =>
  Provider.succeed(
    SnowflakeCatalog,
    catalogLifecycle({
      kind: "Snowflake",
      get: (catalogId) =>
        galaxy.catalog
          .getSnowflakeCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (request: CreateSnowflakeCatalogRequest) =>
        galaxy.catalog
          .createSnowflakeCatalog(request)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, patch: Omit<UpdateSnowflakeCatalogRequest, "catalogId">) =>
        galaxy.catalog.updateSnowflakeCatalog({ ...patch, catalogId }),
      validate: (catalogId) => galaxy.catalog.validateSnowflakeCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteSnowflakeCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listSnowflakeCatalogs.items({}),
      toCreate: (name, props) => ({
        ...settingsOf(name, props),
        ...secretsOf(props.auth),
        validate: props.validate ?? true,
      }),
      toPatch: (name, props, observed, withSecrets) => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          settingsOf(name, props),
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        return {
          ...delta,
          ...(withSecrets ? secretsOf(props.auth) : {}),
          validate: props.validate ?? true,
        };
      },
      toAttributes: (shape: SnowflakeCatalogShape): SnowflakeCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        accountIdentifier: shape.accountIdentifier,
        databaseName: shape.databaseName,
        username: shape.username,
        authenticationType: shape.authenticationType,
        warehouse: shape.warehouse,
        role: shape.role,
        cloudKind: shape.cloudKind,
      }),
      secretsChanged: (olds, news) => secretsDiffer(olds.auth, news.auth),
    }),
  );
