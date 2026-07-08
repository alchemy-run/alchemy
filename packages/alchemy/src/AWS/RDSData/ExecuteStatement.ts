import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface ExecuteStatementOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface ExecuteStatementRequest extends Omit<
  rdsdata.ExecuteStatementRequest,
  "resourceArn" | "secretArn" | "database" | "schema"
> {}

/**
 * Runtime binding for `rds-data:ExecuteStatement`.
 * @binding
 */
export interface ExecuteStatement extends Binding.Service<
  ExecuteStatement,
  "AWS.RDSData.ExecuteStatement",
  (
    cluster: DBCluster,
    options: ExecuteStatementOptions,
  ) => Effect.Effect<
    (
      request: ExecuteStatementRequest,
    ) => Effect.Effect<
      rdsdata.ExecuteStatementResponse,
      rdsdata.ExecuteStatementError
    >
  >
> {}

export const ExecuteStatement = Binding.Service<ExecuteStatement>(
  "AWS.RDSData.ExecuteStatement",
);
