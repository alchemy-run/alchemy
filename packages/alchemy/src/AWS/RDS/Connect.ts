import type * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
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
}

export interface ConnectOptions {
  secret: Secret;
  database?: string;
  port?: number;
  ssl?: boolean;
  subnetIds?: Input<SubnetId[]>;
  securityGroupIds?: Input<SecurityGroupId[]>;
}

/**
 * Runtime binding that resolves connection settings for an Aurora cluster,
 * proxy, or proxy endpoint using a Secrets Manager secret.
 * @binding
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.RDS.Connect",
  (
    resource: ConnectResource,
    options: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<ConnectionInfo, secretsmanager.GetSecretValueError>
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.RDS.Connect");
