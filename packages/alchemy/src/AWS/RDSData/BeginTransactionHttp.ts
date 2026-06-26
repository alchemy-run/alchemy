import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import {
  BeginTransaction,
  type BeginTransactionOptions,
} from "./BeginTransaction.ts";

export const BeginTransactionHttp = Layer.effect(
  BeginTransaction,
  Effect.gen(function* () {
    const beginTransaction = yield* rdsdata.beginTransaction;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: BeginTransactionOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDSData.BeginTransaction(${cluster}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["rds-data:BeginTransaction"],
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
      return Effect.fn(`AWS.RDSData.BeginTransaction(${cluster.LogicalId})`)(
        function* () {
          const clusterArn = yield* resourceArn;
          const resolvedSecretArn = yield* secretArn;
          return yield* beginTransaction({
            resourceArn: clusterArn,
            secretArn: resolvedSecretArn,
            database: options.database,
            schema: options.schema,
          });
        },
      );
    });
  }),
);
