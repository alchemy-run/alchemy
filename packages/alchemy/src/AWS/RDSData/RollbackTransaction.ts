import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface RollbackTransactionOptions {
  secret: Secret;
}

export interface RollbackTransactionRequest extends Omit<
  rdsdata.RollbackTransactionRequest,
  "resourceArn" | "secretArn"
> {}

/**
 * Runtime binding for `rds-data:RollbackTransaction`.
 * @binding
 */
export interface RollbackTransaction extends Binding.Service<
  RollbackTransaction,
  "AWS.RDSData.RollbackTransaction",
  (
    cluster: DBCluster,
    options: RollbackTransactionOptions,
  ) => Effect.Effect<
    (
      request: RollbackTransactionRequest,
    ) => Effect.Effect<
      rdsdata.RollbackTransactionResponse,
      rdsdata.RollbackTransactionError
    >
  >
> {}

export const RollbackTransaction = Binding.Service<RollbackTransaction>(
  "AWS.RDSData.RollbackTransaction",
);
