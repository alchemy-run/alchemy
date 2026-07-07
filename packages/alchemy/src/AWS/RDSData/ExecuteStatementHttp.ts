import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import {
  ExecuteStatement,
  type ExecuteStatementOptions,
  type ExecuteStatementRequest,
} from "./ExecuteStatement.ts";

export const ExecuteStatementHttp = Layer.effect(
  ExecuteStatement,
  Effect.gen(function* () {
    const executeStatement = yield* rdsdata.executeStatement;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: ExecuteStatementOptions,
    ) {
      const resourceArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDSData.ExecuteStatement(${cluster}, ${options.secret}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["rds-data:ExecuteStatement"],
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
      return Effect.fn(`AWS.RDSData.ExecuteStatement(${cluster.LogicalId})`)(
        function* (request: ExecuteStatementRequest) {
          const clusterArn = yield* resourceArn;
          const resolvedSecretArn = yield* secretArn;
          return yield* executeStatement({
            ...request,
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
