import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import {
  CommitTransaction,
  type CommitTransactionOptions,
  type CommitTransactionRequest,
} from "./CommitTransaction.ts";

export const CommitTransactionHttp = Layer.effect(
  CommitTransaction,
  Effect.gen(function* () {
    const commitTransaction = yield* rdsdata.commitTransaction;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: CommitTransactionOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDSData.CommitTransaction(${cluster}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["rds-data:CommitTransaction"],
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
      return Effect.fn(`AWS.RDSData.CommitTransaction(${cluster.LogicalId})`)(
        function* (request: CommitTransactionRequest) {
          const clusterArn = yield* resourceArn;
          const resolvedSecretArn = yield* secretArn;
          return yield* commitTransaction({
            ...request,
            resourceArn: clusterArn,
            secretArn: resolvedSecretArn,
          });
        },
      );
    });
  }),
);
