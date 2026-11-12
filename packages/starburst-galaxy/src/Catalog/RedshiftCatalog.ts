import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateRedshiftCatalogRequest,
  RedshiftCatalog as RedshiftCatalogShape,
  RedshiftCatalogPatch,
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
  secretValue,
} from "./CatalogKind.ts";
import type { CatalogLookup } from "./PostgresqlCatalog.ts";

/** Database user and password. */
export interface RedshiftBasicAuth {
  readonly type: "basic";
  /** Database user Galaxy connects as. */
  readonly username: string;
  /** Password of `username`. Galaxy never returns it. */
  readonly password: Redacted.Redacted<string>;
}

/** IAM credentials of an AWS access key, for a database user. */
export interface RedshiftAccessKeyAuth {
  readonly type: "accessKey";
  /** Database user Galaxy connects as. */
  readonly username: string;
  /** AWS access key ID. */
  readonly accessKey: string;
  /** AWS secret access key. Galaxy never returns it. */
  readonly secretKey: Redacted.Redacted<string>;
  /** AWS region of the Redshift cluster, e.g. `us-east-1`. */
  readonly region: string;
}

/** A cross-account IAM role Galaxy assumes (see `StarburstGalaxy.CrossAccountIamRole`). */
export interface RedshiftRoleAuth {
  readonly type: "role";
  /** Database user Galaxy connects as. */
  readonly username: string;
  /** ARN of the IAM role registered with Galaxy. */
  readonly roleArn: string;
  /** AWS region of the Redshift cluster, e.g. `us-east-1`. */
  readonly region: string;
}

export type RedshiftAuth = RedshiftBasicAuth | RedshiftAccessKeyAuth | RedshiftRoleAuth;

export interface RedshiftCatalogProps extends CatalogBaseProps {
  /**
   * JDBC endpoint of the cluster or serverless workgroup:
   * `<host>:<port>/<database>`, e.g.
   * `analytics.abc123.us-east-1.redshift.amazonaws.com:5439/dev`.
   */
  readonly endpoint: string;
  /**
   * How Galaxy signs in. Changing `type` replaces the catalog: Galaxy keeps
   * a catalog's authentication type on update.
   */
  readonly auth: RedshiftAuth;
  /** ID of a Galaxy SSH tunnel to reach a private cluster through. */
  readonly sshTunnelId?: string;
}

export interface RedshiftCatalogAttributes extends CatalogBaseAttributes {
  /** JDBC endpoint Galaxy connects to. */
  readonly endpoint: string;
  /** How Galaxy signs in: `basic`, `accessKey` or `role`. */
  readonly authType: "basic" | "accessKey" | "role";
  /** Database user Galaxy connects as. */
  readonly username: string;
  /** SSH tunnel Galaxy connects through, if any. */
  readonly sshTunnelId: string | undefined;
}

export type RedshiftCatalog = Resource<
  "StarburstGalaxy.RedshiftCatalog",
  RedshiftCatalogProps,
  RedshiftCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over an Amazon Redshift database: its schemas
 * and tables become `<catalog>.<schema>.<table>` on every cluster the
 * catalog is attached to.
 *
 * Every setting, the name included, updates in place except the
 * authentication type, which replaces the catalog. Galaxy never returns
 * passwords or secret keys, so a rotated secret is detected by comparing the
 * deployed value with the new one. Galaxy checks the connection on every
 * create and update; set `validate: false` to store a catalog it cannot
 * reach yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/redshift.html
 *
 * ### Creating a catalog
 * **Example:** A user and password
 * ```typescript
 * const password = yield* Config.Redacted("REDSHIFT_PASSWORD");
 * const dw = yield* StarburstGalaxy.RedshiftCatalog("Warehouse", {
 *   endpoint: "analytics.abc123.us-east-1.redshift.amazonaws.com:5439/dev",
 *   auth: { type: "basic", username: "galaxy", password },
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [dw.catalogId],
 * });
 * ```
 *
 * ### Signing in with an IAM role
 * **Example:** A role registered as a cross-account IAM role
 * ```typescript
 * yield* StarburstGalaxy.RedshiftCatalog("Warehouse", {
 *   endpoint: "analytics.abc123.us-east-1.redshift.amazonaws.com:5439/dev",
 *   auth: {
 *     type: "role",
 *     username: "galaxy",
 *     roleArn: "arn:aws:iam::123456789012:role/galaxy-redshift",
 *     region: "us-east-1",
 *   },
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const dw = StarburstGalaxy.RedshiftCatalog.lookup({ name: "warehouse" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const RedshiftCatalog = Resource<RedshiftCatalog>("StarburstGalaxy.RedshiftCatalog");

/** The auth's non-secret settings, as Galaxy names them. */
const authSettingsOf = (auth: RedshiftAuth) =>
  auth.type === "basic"
    ? { username: auth.username }
    : auth.type === "accessKey"
      ? { username: auth.username, accessKey: auth.accessKey, region: auth.region }
      : { username: auth.username, roleArn: auth.roleArn, region: auth.region };

const secretsOf = (auth: RedshiftAuth) =>
  auth.type === "basic"
    ? { password: auth.password }
    : auth.type === "accessKey"
      ? { secretKey: auth.secretKey }
      : {};

const secretOf = (auth: RedshiftAuth) =>
  auth.type === "basic"
    ? secretValue(auth.password)
    : auth.type === "accessKey"
      ? secretValue(auth.secretKey)
      : undefined;

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: RedshiftCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  endpoint: props.endpoint,
  sshTunnelId: props.sshTunnelId,
  ...authSettingsOf(props.auth),
});

export const RedshiftCatalogProvider = () =>
  Provider.succeed(
    RedshiftCatalog,
    catalogLifecycle({
      kind: "Redshift",
      get: (catalogId) =>
        galaxy.catalog
          .getRedshiftCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateRedshiftCatalogRequest) =>
        galaxy.catalog
          .createRedshiftCatalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: RedshiftCatalogPatch) =>
        galaxy.catalog.updateRedshiftCatalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateRedshiftCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteRedshiftCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listRedshiftCatalogs.items({}),
      toCreate: (name, props) =>
        ({
          ...settingsOf(name, props),
          ...secretsOf(props.auth),
          authType: props.auth.type,
          validate: props.validate ?? true,
        }) as CreateRedshiftCatalogRequest,
      toPatch: (name, props, observed, withSecrets) => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          settingsOf(name, props),
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        return {
          ...delta,
          ...(withSecrets ? secretsOf(props.auth) : {}),
          authType: props.auth.type,
          validate: props.validate ?? true,
        } as RedshiftCatalogPatch;
      },
      toAttributes: (shape: RedshiftCatalogShape): RedshiftCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        endpoint: shape.endpoint,
        authType: shape.authType,
        username: shape.username,
        sshTunnelId: shape.sshTunnelId,
      }),
      secretsChanged: (olds, news) => secretOf(olds.auth) !== secretOf(news.auth),
      replaces: (olds, news) => olds.auth.type !== news.auth.type,
    }),
  );
