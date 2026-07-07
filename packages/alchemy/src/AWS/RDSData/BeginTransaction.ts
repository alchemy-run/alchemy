import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface BeginTransactionOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

/**
 * Runtime binding for `rds-data:BeginTransaction`.
 * @binding
 */
export interface BeginTransaction extends Binding.Service<
  BeginTransaction,
  "AWS.RDSData.BeginTransaction",
  (
    cluster: DBCluster,
    options: BeginTransactionOptions,
  ) => Effect.Effect<
    () => Effect.Effect<
      rdsdata.BeginTransactionResponse,
      rdsdata.BeginTransactionError
    >
  >
> {}

export const BeginTransaction = Binding.Service<BeginTransaction>(
  "AWS.RDSData.BeginTransaction",
);
