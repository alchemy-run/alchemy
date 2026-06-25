import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface CommitTransactionOptions {
  secret: Secret;
}

export interface CommitTransactionRequest extends Omit<
  rdsdata.CommitTransactionRequest,
  "resourceArn" | "secretArn"
> {}

/**
 * Runtime binding for `rds-data:CommitTransaction`.
 * @binding
 */
export interface CommitTransaction extends Binding.Service<
  CommitTransaction,
  "AWS.RDSData.CommitTransaction",
  (
    cluster: DBCluster,
    options: CommitTransactionOptions,
  ) => Effect.Effect<
    (
      request: CommitTransactionRequest,
    ) => Effect.Effect<
      rdsdata.CommitTransactionResponse,
      rdsdata.CommitTransactionError
    >
  >
> {}

export const CommitTransaction = Binding.Service<CommitTransaction>(
  "AWS.RDSData.CommitTransaction",
);
