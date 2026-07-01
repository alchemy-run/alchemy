import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface BatchExecuteStatementOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface BatchExecuteStatementRequest extends Omit<
  rdsdata.BatchExecuteStatementRequest,
  "resourceArn" | "secretArn" | "database" | "schema"
> {}

/**
 * Runtime binding for `rds-data:BatchExecuteStatement`.
 * @binding
 */
export interface BatchExecuteStatement extends Binding.Service<
  BatchExecuteStatement,
  "AWS.RDSData.BatchExecuteStatement",
  (
    cluster: DBCluster,
    options: BatchExecuteStatementOptions,
  ) => Effect.Effect<
    (
      request: BatchExecuteStatementRequest,
    ) => Effect.Effect<
      rdsdata.BatchExecuteStatementResponse,
      rdsdata.BatchExecuteStatementError
    >
  >
> {}

export const BatchExecuteStatement = Binding.Service<BatchExecuteStatement>(
  "AWS.RDSData.BatchExecuteStatement",
);
