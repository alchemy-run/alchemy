import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Presign from "@distilled.cloud/aws/Presign";
import type * as Region from "@distilled.cloud/aws/Region";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as AWSBindings from "../AWSBindings.ts";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";
import { formatSqlConnectionUrl } from "../Connection/internal.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { Secret } from "../SecretsManager/Secret.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBInstance } from "./DBInstance.ts";
import type { DBProxy } from "./DBProxy.ts";
import type { DBProxyEndpoint } from "./DBProxyEndpoint.ts";

export type ConnectResource = DBCluster | DBInstance | DBProxy | DBProxyEndpoint;

export interface ConnectionInfo {
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  ssl: boolean;
  /**
   * RFC-3986 connection URL — feeds `Drizzle.Postgres` / a Hyperdrive
   * origin directly. `Redacted` because it embeds the password.
   */
  url: Redacted.Redacted<string>;
  /**
   * IAM auth mode only: re-mints a fresh short-lived (15 minute) IAM
   * database authentication token.
   *
   * Per-execution pools (Lambda invoke, Worker event) never need it — the
   * `Connect` runtime effect re-runs on each execution and mints a fresh
   * token as `password`/`url`. Long-lived serverful pools (ECS Task /
   * ServerHost) should wire this into the driver's lazy-password hook
   * (`@effect/sql-pg` `password: Effect`, `postgres.js` `pass: () => ...`) so every
   * new physical connection authenticates with a fresh token instead of a
   * token minted at pool construction.
   */
  refreshPassword?: Effect.Effect<Redacted.Redacted<string>, Presign.PresignError>;
}

interface ConnectOptionsBase {
  database?: string;
  port?: number;
  ssl?: boolean;
  /**
   * Subnets the host Function should be attached to so it can open a
   * socket to the database. Wired through the host's `vpc` binding
   * channel — equivalent to setting the Function's `vpc` prop manually.
   */
  subnetIds?: Input<SubnetId[]>;
  /**
   * Security groups for the host Function's VPC attachment (see
   * {@link ConnectOptionsBase.subnetIds}). The referenced groups must be
   * allowed ingress on the database port by the database's security
   * group.
   */
  securityGroupIds?: Input<SecurityGroupId[]>;
}

/**
 * Default credential strategy: read `{ username, password }` from a
 * Secrets Manager secret. The deploy half grants
 * `secretsmanager:GetSecretValue` on the secret; the runtime half fetches
 * and parses it.
 */
export interface SecretConnectOptions extends ConnectOptionsBase {
  /** @default "secret" */
  auth?: "secret";
  /**
   * Secret whose JSON payload carries `username` and `password`. Required
   * for a proxy. For a `DBInstance` or `DBCluster` it defaults to the
   * database's RDS-managed master user secret (`manageMasterUserPassword:
   * true`); a managed secret encrypted with a customer-managed KMS key also
   * needs `kms:Decrypt` on that key.
   * @default the RDS-managed master user secret
   */
  secret?: Secret;
}

/**
 * IAM database authentication: the deploy half grants `rds-db:connect` on
 * `arn:aws:rds-db:{region}:{account}:dbuser:{resourceId}/{username}`; the
 * runtime half presigns a short-lived auth token as the password. Requires
 * `enableIAMDatabaseAuthentication: true` on the database and a database
 * user granted the `rds_iam` role (Postgres) / `AWSAuthenticationPlugin`
 * (MySQL). TLS is mandatory — `ssl` is forced to `true`.
 */
export interface IamConnectOptions extends ConnectOptionsBase {
  auth: "iam";
  /** Database user the IAM token authenticates as. */
  username: string;
}

export type ConnectOptions = SecretConnectOptions | IamConnectOptions;

/**
 * Runtime binding that resolves connection settings for an Aurora cluster,
 * RDS instance, proxy, or proxy endpoint using a Secrets Manager secret or
 * IAM database authentication.
 *
 * Binding it yields an Effect (not a callable) that resolves a
 * `ConnectionInfo` — host, port, credentials, and a ready-to-use `url` —
 * fresh on every execution. No socket is opened; feed the result into your
 * database driver. Provide the implementation with
 * `Effect.provide(AWS.RDS.ConnectHttp)`.
 * ### Connecting to a Database
 * **Example:** Resolve Credentials from a Secret
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     const db = yield* AWS.RDS.Aurora("AppDb", {
 *       subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *       securityGroupIds: [dbSecurityGroup.groupId],
 *     });
 *     // init — bind the cluster + admin secret; grants
 *     // secretsmanager:GetSecretValue and (optionally) attaches the
 *     // function to the given subnets/security groups
 *     const connect = yield* AWS.RDS.Connect(db.cluster, {
 *       secret: db.secret,
 *       database: "app",
 *       subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *       securityGroupIds: [appSecurityGroup.groupId],
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — resolve host/port/credentials, hand `info.url`
 *         // (Redacted) to SQL.Postgres / Drizzle.Postgres
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({
 *           host: info.host,
 *           port: info.port,
 *           database: info.database,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.RDS.ConnectHttp)),
 * );
 * ```
 *
 * **Example:** Connect to an RDS Instance with its Managed Secret
 * ```typescript
 * const instance = yield* AWS.RDS.DBInstance("AppDb", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t4g.micro",
 *   masterUsername: "app",
 *   manageMasterUserPassword: true,
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   vpcSecurityGroupIds: [dbSecurityGroup.groupId],
 * });
 * // no `secret` — reads the RDS-managed master user secret
 * const connect = yield* AWS.RDS.Connect(instance, {
 *   database: "postgres",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [appSecurityGroup.groupId],
 * });
 * ```
 *
 * **Example:** IAM Database Authentication
 * ```typescript
 * // init — grants rds-db:connect for the `app_iam` user; the runtime half
 * // presigns a short-lived (15 minute) auth token as the password
 * const connect = yield* AWS.RDS.Connect(db.cluster, {
 *   auth: "iam",
 *   username: "app_iam",
 *   database: "app",
 * });
 *
 * // runtime — long-lived pools should wire info.refreshPassword into the
 * // driver's lazy-password hook so each new connection gets a fresh token
 * const info = yield* connect;
 * ```
 *
 * @binding
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.RDS.Connect",
  (
    resource: ConnectResource,
    options: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<
      ConnectionInfo,
      secretsmanager.GetSecretValueError | Presign.PresignError,
      RuntimeContext
    >
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.RDS.Connect");

/**
 * `Connect` was bound without a `secret` to a proxy, or to a database that
 * has no RDS-managed master user secret (`manageMasterUserPassword` is off).
 */
export class ManagedMasterSecretNotFound extends Data.TaggedError("ManagedMasterSecretNotFound")<{
  message: string;
}> {}

/**
 * `arn:{partition}:rds-db:{region}:{account}:dbuser:{resourceId}/{username}`
 * derived from another RDS ARN in the same account/region.
 */
const rdsDbUserArn = (sourceArn: string, resourceId: string, username: string): string => {
  const [, partition, , region, accountId] = sourceArn.split(":");
  return `arn:${partition}:rds-db:${region}:${accountId}:dbuser:${resourceId}/${username}`;
};

/**
 * The `rds-db:connect` resource for IAM database authentication.
 *
 * - DBCluster — the cluster's `DbClusterResourceId` (`cluster-XXXX`).
 * - DBInstance — the instance's `DbiResourceId` (`db-XXXX`).
 * - DBProxy — the proxy id (`prx-XXXX`), the last segment of the proxy ARN.
 * - DBProxyEndpoint — the parent proxy's `prx-` id is not an endpoint
 *   attribute, so the resource id is wildcarded to the account/region
 *   (still scoped to the exact `username`).
 */
const dbUserArn = (resource: ConnectResource, username: string) => {
  switch (resource.Type) {
    case "AWS.RDS.DBCluster":
      return Output.map(
        Output.all(resource.dbClusterArn, resource.dbClusterResourceId),
        ([arn, resourceId]) => rdsDbUserArn(arn, resourceId ?? "*", username),
      );
    case "AWS.RDS.DBInstance":
      return Output.map(
        Output.all(resource.dbInstanceArn, resource.dbiResourceId),
        ([arn, resourceId]) => rdsDbUserArn(arn, resourceId ?? "*", username),
      );
    case "AWS.RDS.DBProxy":
      return Output.map(resource.dbProxyArn, (arn) =>
        rdsDbUserArn(arn, arn.split(":")[6] ?? "*", username),
      );
    default:
      return Output.map(resource.dbProxyEndpointArn, (arn) => rdsDbUserArn(arn, "*", username));
  }
};

const managedSecretArn = (resource: ConnectResource): Output.Output<string, never> =>
  (resource.Type === "AWS.RDS.DBCluster" || resource.Type === "AWS.RDS.DBInstance"
    ? resource.masterUserSecretArn
    : Output.literal<string | undefined>(undefined)
  ).pipe(
    Output.mapEffect((arn) =>
      arn
        ? Effect.succeed(arn)
        : Effect.die(
            new ManagedMasterSecretNotFound({
              message: `AWS.RDS.Connect(${resource.LogicalId}) has no \`secret\` and ${resource.LogicalId} has no RDS-managed master user secret. Pass \`secret\`, set \`manageMasterUserPassword: true\`, or use \`auth: "iam"\`.`,
            }),
          ),
    ),
  );

export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getSecretValue = yield* AWSBindings.withCredentials(secretsmanager.getSecretValue);
    // Ambient AWS identity for the IAM-auth token presign — captured at
    // layer build so the runtime client stays `RuntimeContext`-colored.
    const services = yield* AWSBindings.withCredentials(
      Effect.context<Credentials.Credentials | Region.Region>(),
    );

    return Effect.fn(function* (resource: ConnectResource, options: ConnectOptions) {
      // Without an explicit `secret`, read the database's RDS-managed master
      // user secret. The IAM grant checks it exists, so its absence fails the
      // deploy, not the first request; the runtime reads the plain attribute.
      const secretArn: Output.Output<string, never> | undefined =
        options.auth === "iam"
          ? undefined
          : options.secret
            ? options.secret.secretArn
            : managedSecretArn(resource);
      const SecretId =
        options.auth === "iam"
          ? undefined
          : options.secret
            ? yield* options.secret.secretArn
            : resource.Type === "AWS.RDS.DBCluster" || resource.Type === "AWS.RDS.DBInstance"
              ? yield* resource.masterUserSecretArn
              : undefined;
      const Host =
        resource.Type === "AWS.RDS.DBInstance"
          ? yield* resource.endpointAddress
          : yield* resource.endpoint;
      const Port =
        resource.Type === "AWS.RDS.DBCluster"
          ? yield* resource.port
          : resource.Type === "AWS.RDS.DBInstance"
            ? yield* resource.endpointPort
            : undefined;
      // Engine flavor drives the connection-URL scheme. Proxy endpoints
      // carry no engine attribute — they default to postgres below.
      const Engine =
        resource.Type === "AWS.RDS.DBCluster" || resource.Type === "AWS.RDS.DBInstance"
          ? yield* resource.engine
          : resource.Type === "AWS.RDS.DBProxy"
            ? yield* resource.engineFamily
            : undefined;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Attach the host to the database's VPC (also available as a plain
        // Function prop for the manual case).
        const vpc =
          options.subnetIds !== undefined || options.securityGroupIds !== undefined
            ? {
                subnetIds: options.subnetIds ?? [],
                securityGroupIds: options.securityGroupIds ?? [],
              }
            : undefined;
        if (options.auth === "iam") {
          yield* bind`AWS.RDS.Connect(${resource}, ${options.username})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["rds-db:connect"],
                Resource: [dbUserArn(resource, options.username)],
              },
            ],
          });
        } else {
          yield* bind`AWS.RDS.Connect(${options.secret ?? resource})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
                Resource: [secretArn!],
              },
            ],
          });
        }
        if (vpc !== undefined) {
          yield* AWSBindings.bindVpc`AWS.RDS.Connect(${resource})`(vpc);
        }
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = Port ? yield* Port : undefined;
        const engine = Engine ? yield* Engine : undefined;

        if (!host) {
          return yield* Effect.die(`RDS endpoint is not available yet`);
        }

        const resolvedPort = options.port ?? port ?? 5432;
        const scheme = engine?.toLowerCase().includes("mysql") ? "mysql" : "postgresql";

        if (options.auth === "iam") {
          // IAM database authentication mandates TLS.
          const ssl = true;
          const mintToken = generateDbAuthToken({
            service: "rds-db",
            hostname: host,
            port: resolvedPort,
            username: options.username,
          }).pipe(Effect.provideContext(services));
          const token = yield* mintToken;
          return {
            host,
            port: resolvedPort,
            database: options.database,
            username: options.username,
            password: Redacted.value(token),
            ssl,
            url: formatSqlConnectionUrl({
              scheme,
              host,
              port: resolvedPort,
              database: options.database,
              username: options.username,
              password: token,
              ssl,
              // RDS certificates chain to a private AWS CA that Node's
              // trust store doesn't carry — `no-verify` keeps TLS on
              // (mandatory for IAM auth) with libpq `require` semantics.
              sslMode: "no-verify",
            }),
            refreshPassword: mintToken,
          };
        }

        const secretId = SecretId ? yield* SecretId : undefined;
        if (!secretId) {
          return yield* Effect.die(
            new ManagedMasterSecretNotFound({
              message: `AWS.RDS.Connect(${resource.LogicalId}) has no \`secret\` and no RDS-managed master user secret`,
            }),
          );
        }
        const value = yield* getSecretValue({
          SecretId: secretId,
        });
        const secretString = value.SecretString
          ? typeof value.SecretString === "string"
            ? value.SecretString
            : Redacted.value(value.SecretString)
          : "{}";
        const secret = JSON.parse(secretString) as {
          username?: string;
          password?: string;
        };

        const ssl = options.ssl ?? true;
        return {
          host,
          port: resolvedPort,
          database: options.database,
          username: secret.username,
          password: secret.password,
          ssl,
          url: formatSqlConnectionUrl({
            scheme,
            host,
            port: resolvedPort,
            database: options.database,
            username: secret.username,
            password: secret.password,
            ssl,
            // See the IAM branch — RDS certs chain to a private CA.
            sslMode: "no-verify",
          }),
        };
      });
    });
  }),
);
