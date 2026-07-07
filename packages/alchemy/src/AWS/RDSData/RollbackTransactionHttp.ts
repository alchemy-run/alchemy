import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import {
  RollbackTransaction,
  type RollbackTransactionOptions,
  type RollbackTransactionRequest,
} from "./RollbackTransaction.ts";

export const RollbackTransactionHttp = Layer.effect(
  RollbackTransaction,
  Effect.gen(function* () {
    const rollbackTransaction = yield* rdsdata.rollbackTransaction;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: RollbackTransactionOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDSData.RollbackTransaction(${cluster}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["rds-data:RollbackTransaction"],
                  Resource: [cluster.dbClusterArn, options.secret.secretArn],
                },
              ],
            },
          );
          yield* host.bind`Allow(${host}, AWS.SecretsManager.GetSecretValue(${options.secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "secretsmanager:GetSecretValue",
                    "secretsmanager:DescribeSecret",
                  ],
                  Resource: [options.secret.secretArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.RDSData.RollbackTransaction(${cluster.LogicalId})`)(
        function* (request: RollbackTransactionRequest) {
          const clusterArn = yield* resourceArn;
          const resolvedSecretArn = yield* secretArn;
          return yield* rollbackTransaction({
            ...request,
            resourceArn: clusterArn,
            secretArn: resolvedSecretArn,
          });
        },
      );
    });
  }),
);
