import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import {
  BatchExecuteStatement,
  type BatchExecuteStatementOptions,
  type BatchExecuteStatementRequest,
} from "./BatchExecuteStatement.ts";

export const BatchExecuteStatementHttp = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    const batchExecuteStatement = yield* rdsdata.batchExecuteStatement;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: BatchExecuteStatementOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDSData.BatchExecuteStatement(${cluster}, ${options.secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["rds-data:BatchExecuteStatement"],
                  Resource: [cluster.dbClusterArn, options.secret.secretArn],
                },
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
      return Effect.fn(
        `AWS.RDSData.BatchExecuteStatement(${cluster.LogicalId})`,
      )(function* (request: BatchExecuteStatementRequest) {
        const clusterArn = yield* resourceArn;
        const resolvedSecretArn = yield* secretArn;
        return yield* batchExecuteStatement({
          ...request,
          resourceArn: clusterArn,
          secretArn: resolvedSecretArn,
          database: options.database,
          schema: options.schema,
        });
      });
    });
  }),
);
