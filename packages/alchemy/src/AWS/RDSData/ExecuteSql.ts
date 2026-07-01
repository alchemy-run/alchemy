import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface ExecuteSqlOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface ExecuteSqlRequest extends Omit<
  rdsdata.ExecuteSqlRequest,
  "dbClusterOrInstanceArn" | "awsSecretStoreArn" | "database" | "schema"
> {}

/**
 * Runtime binding for the deprecated `rds-data:ExecuteSql` API.
 * @binding
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "AWS.RDSData.ExecuteSql",
  (
    cluster: DBCluster,
    options: ExecuteSqlOptions,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<rdsdata.ExecuteSqlResponse, rdsdata.ExecuteSqlError>
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("AWS.RDSData.ExecuteSql");
