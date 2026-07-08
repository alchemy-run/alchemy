import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import {
  ExecuteSql,
  type ExecuteSqlOptions,
  type ExecuteSqlRequest,
} from "./ExecuteSql.ts";

export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const executeSql = yield* rdsdata.executeSql;

    return Effect.fn(function* (
      cluster: DBCluster,
      options: ExecuteSqlOptions,
    ) {
      const clusterArn = yield* cluster.dbClusterArn;
      const secretArn = yield* options.secret.secretArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.RDSData.ExecuteSql(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["rds-data:ExecuteSql"],
                Resource: [cluster.dbClusterArn, options.secret.secretArn],
              },
            ],
          });
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
      return Effect.fn(`AWS.RDSData.ExecuteSql(${cluster.LogicalId})`)(
        function* (request: ExecuteSqlRequest) {
          return yield* executeSql({
            ...request,
            dbClusterOrInstanceArn: yield* clusterArn,
            awsSecretStoreArn: yield* secretArn,
            database: options.database,
            schema: options.schema,
          });
        },
      );
    });
  }),
);
