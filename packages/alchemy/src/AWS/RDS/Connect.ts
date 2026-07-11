import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { Secret } from "../SecretsManager/Secret.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBProxy } from "./DBProxy.ts";
import type { DBProxyEndpoint } from "./DBProxyEndpoint.ts";

export type ConnectResource = DBCluster | DBProxy | DBProxyEndpoint;

export interface ConnectionInfo {
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  ssl: boolean;
  /**
   * RFC-3986 connection URL — feeds `Drizzle.postgres` / a Hyperdrive
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
   * (`postgres.js` `pass: () => ...`, `pg` `password: () => ...`) so every
   * new physical connection authenticates with a fresh token instead of a
   * token minted at pool construction.
   */
  refreshPassword?: Effect.Effect<
    Redacted.Redacted<string>,
    Credentials.CredentialsError
  >;
}

interface ConnectOptionsBase {
  database?: string;
  port?: number;
  ssl?: boolean;
  /**
   * Subnets the host Function should be attached to so it can open a
   * socket to the cluster/proxy. Wired through the host's `vpc` binding
   * channel — equivalent to setting the Function's `vpc` prop manually.
   */
  subnetIds?: Input<SubnetId[]>;
  /**
   * Security groups for the host Function's VPC attachment (see
   * {@link ConnectOptionsBase.subnetIds}). The referenced groups must be
   * allowed ingress on the database port by the cluster/proxy's security
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
  secret: Secret;
}

/**
 * IAM database authentication: the deploy half grants `rds-db:connect` on
 * `arn:aws:rds-db:{region}:{account}:dbuser:{resourceId}/{username}`; the
 * runtime half presigns a short-lived auth token as the password. Requires
 * `enableIAMDatabaseAuthentication: true` on the cluster and a database
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
 * proxy, or proxy endpoint using a Secrets Manager secret or IAM database
 * authentication.
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
      secretsmanager.GetSecretValueError | Credentials.CredentialsError,
      RuntimeContext
    >
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.RDS.Connect");
