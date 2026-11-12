import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateOpenSearchCatalogRequest,
  OpenSearchCatalog as OpenSearchCatalogShape,
  OpenSearchCatalogPatch,
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
  type CatalogLookup,
  catalogLifecycle,
  secretValue,
} from "./CatalogKind.ts";

/** An internal user and password (OpenSearch fine-grained access control). */
export interface OpenSearchBasicAuth {
  readonly type: "basic";
  /** OpenSearch user Galaxy connects as. */
  readonly username: string;
  /** Password of `username`. Galaxy never returns it. */
  readonly password: Redacted.Redacted<string>;
}

/** SigV4 signing with an AWS access key (Amazon OpenSearch Service). */
export interface OpenSearchAccessKeyAuth {
  readonly type: "accessKey";
  /** AWS access key ID. */
  readonly accessKey: string;
  /** AWS secret access key. Galaxy never returns it. */
  readonly secretKey: Redacted.Redacted<string>;
  /** AWS region of the domain, e.g. `us-east-1`. */
  readonly region: string;
}

/** SigV4 signing as a cross-account IAM role (see `StarburstGalaxy.CrossAccountIamRole`). */
export interface OpenSearchRoleAuth {
  readonly type: "role";
  /** ARN of the IAM role registered with Galaxy. */
  readonly roleArn: string;
  /** AWS region of the domain, e.g. `us-east-1`. */
  readonly region: string;
}

export type OpenSearchAuth = OpenSearchBasicAuth | OpenSearchAccessKeyAuth | OpenSearchRoleAuth;

export interface OpenSearchCatalogProps extends CatalogBaseProps {
  /** URL of the domain, with its scheme: `https://search-logs-abc.us-east-1.es.amazonaws.com`. */
  readonly endpoint: string;
  /**
   * Port of the domain. Galaxy requires 443 with `accessKey` auth.
   * @default 443
   */
  readonly port?: number;
  /**
   * How Galaxy signs in. Changing `type` replaces the catalog: Galaxy keeps
   * a catalog's authentication type on update.
   */
  readonly auth: OpenSearchAuth;
  /** ID of a Galaxy SSH tunnel to reach a private domain through. */
  readonly sshTunnelId?: string;
}

export interface OpenSearchCatalogAttributes extends CatalogBaseAttributes {
  /** URL Galaxy connects to. */
  readonly endpoint: string;
  /** Port Galaxy connects to. */
  readonly port: number | undefined;
  /** How Galaxy signs in: `basic`, `accessKey` or `role`. */
  readonly authType: "basic" | "accessKey" | "role";
  /** SSH tunnel Galaxy connects through, if any. */
  readonly sshTunnelId: string | undefined;
}

export type OpenSearchCatalog = Resource<
  "StarburstGalaxy.OpenSearchCatalog",
  OpenSearchCatalogProps,
  OpenSearchCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over an OpenSearch domain: indexes become
 * tables of the `default` schema, queried as `<catalog>.default.<index>`.
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
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/opensearch.html
 *
 * ### Creating a catalog
 * **Example:** An Amazon OpenSearch Service domain, signed with an IAM role
 * ```typescript
 * const logs = yield* StarburstGalaxy.OpenSearchCatalog("Logs", {
 *   endpoint: "https://search-logs-abc123.us-east-1.es.amazonaws.com",
 *   auth: {
 *     type: "role",
 *     roleArn: "arn:aws:iam::123456789012:role/galaxy-opensearch",
 *     region: "us-east-1",
 *   },
 *   readOnly: true,
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [logs.catalogId],
 * });
 * ```
 *
 * ### Signing in with a user
 * **Example:** Fine-grained access control's internal user
 * ```typescript
 * const password = yield* Config.Redacted("OPENSEARCH_PASSWORD");
 * yield* StarburstGalaxy.OpenSearchCatalog("Logs", {
 *   endpoint: "https://logs.example.com",
 *   auth: { type: "basic", username: "galaxy", password },
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const logs = StarburstGalaxy.OpenSearchCatalog.lookup({ name: "logs" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const OpenSearchCatalog = Resource<OpenSearchCatalog>("StarburstGalaxy.OpenSearchCatalog");

/** The auth's non-secret settings, as Galaxy names them. */
const authSettingsOf = (auth: OpenSearchAuth) =>
  auth.type === "basic"
    ? { username: auth.username }
    : auth.type === "accessKey"
      ? { accessKey: auth.accessKey, region: auth.region }
      : { roleArn: auth.roleArn, region: auth.region };

const secretsOf = (auth: OpenSearchAuth) =>
  auth.type === "basic"
    ? { password: auth.password }
    : auth.type === "accessKey"
      ? { secretKey: auth.secretKey }
      : {};

const secretOf = (auth: OpenSearchAuth) =>
  auth.type === "basic"
    ? secretValue(auth.password)
    : auth.type === "accessKey"
      ? secretValue(auth.secretKey)
      : undefined;

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: OpenSearchCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  endpoint: props.endpoint,
  port: props.port,
  sshTunnelId: props.sshTunnelId,
});

export const OpenSearchCatalogProvider = () =>
  Provider.succeed(
    OpenSearchCatalog,
    catalogLifecycle({
      kind: "OpenSearch",
      get: (catalogId) =>
        galaxy.catalog
          .getOpenSearchCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateOpenSearchCatalogRequest) =>
        galaxy.catalog
          .createOpenSearchCatalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: OpenSearchCatalogPatch) =>
        galaxy.catalog.updateOpenSearchCatalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateOpenSearchCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteOpenSearchCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listOpenSearchCatalogs.items({}),
      toCreate: (name, props): CreateOpenSearchCatalogRequest => {
        const fields = { ...settingsOf(name, props), validate: props.validate ?? true };
        const auth = props.auth;
        switch (auth.type) {
          case "basic":
            return {
              ...fields,
              authType: "basic",
              username: auth.username,
              password: auth.password,
            };
          case "accessKey":
            return {
              ...fields,
              authType: "accessKey",
              accessKey: auth.accessKey,
              secretKey: auth.secretKey,
              region: auth.region,
            };
          case "role":
            return { ...fields, authType: "role", roleArn: auth.roleArn, region: auth.region };
        }
      },
      toPatch: (name, props, observed, withSecrets): OpenSearchCatalogPatch | undefined => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          { ...settingsOf(name, props), ...authSettingsOf(props.auth) },
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        const fields = {
          ...delta,
          ...(withSecrets ? secretsOf(props.auth) : {}),
          validate: props.validate ?? true,
        };
        // The auth type never changes in place (it replaces), so the patch uses the current one.
        switch (props.auth.type) {
          case "basic":
            return { ...fields, authType: "basic" };
          case "accessKey":
            return { ...fields, authType: "accessKey" };
          case "role":
            return { ...fields, authType: "role" };
        }
      },
      toAttributes: (shape: OpenSearchCatalogShape): OpenSearchCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        endpoint: shape.endpoint,
        port: shape.port,
        authType: shape.authType,
        sshTunnelId: shape.sshTunnelId,
      }),
      secretsChanged: (olds, news) => secretOf(olds.auth) !== secretOf(news.auth),
      replaces: (olds, news) => olds.auth.type !== news.auth.type,
    }),
  );
