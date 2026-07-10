import * as data from "@distilled.cloud/aws/redshift-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Workgroup } from "../RedshiftServerless/Workgroup.ts";
import {
  RedshiftStatementFailed,
  Statements,
  type ExecuteStatementRequest,
  type StatementsClient,
  type StatementsOptions,
} from "./Statements.ts";

/** Statement statuses that mean the run is over. */
const isTerminal = (status: string | undefined): boolean =>
  status === "FINISHED" || status === "FAILED" || status === "ABORTED";

export const StatementsHttp = Layer.effect(
  Statements,
  Effect.gen(function* () {
    const executeStatement = yield* data.executeStatement;
    const describeStatement = yield* data.describeStatement;
    const getStatementResult = yield* data.getStatementResult;

    return Effect.fn(function* (
      workgroup: Workgroup,
      options: StatementsOptions = {},
    ) {
      const workgroupName = yield* workgroup.workgroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.RedshiftData.Statements(${workgroup}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "redshift-data:ExecuteStatement",
                    "redshift-data:BatchExecuteStatement",
                  ],
                  Resource: [workgroup.workgroupArn],
                },
                {
                  // DescribeStatement/GetStatementResult/CancelStatement are
                  // authorized per-statement (owner condition), not by ARN.
                  Effect: "Allow",
                  Action: [
                    "redshift-data:DescribeStatement",
                    "redshift-data:GetStatementResult",
                    "redshift-data:CancelStatement",
                  ],
                  Resource: ["*"],
                },
                {
                  // IAM temporary-credential auth against the serverless
                  // workgroup (used when no SecretArn is supplied).
                  Effect: "Allow",
                  Action: ["redshift-serverless:GetCredentials"],
                  Resource: [workgroup.workgroupArn],
                },
                ...(options.secretArn
                  ? [
                      {
                        Effect: "Allow" as const,
                        Action: [
                          "secretsmanager:GetSecretValue",
                          "secretsmanager:DescribeSecret",
                        ],
                        Resource: [options.secretArn],
                      },
                    ]
                  : []),
              ],
            },
          );
        }
      }

      const database = options.database ?? "dev";

      const execute = Effect.fn(
        `AWS.RedshiftData.Statements.execute(${workgroup.LogicalId})`,
      )(function* (request: ExecuteStatementRequest) {
        return yield* executeStatement({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const describe = Effect.fn(
        `AWS.RedshiftData.Statements.describe(${workgroup.LogicalId})`,
      )(function* (id: string) {
        return yield* describeStatement({ Id: id });
      });

      const getResult = Effect.fn(
        `AWS.RedshiftData.Statements.getResult(${workgroup.LogicalId})`,
      )(function* (id: string) {
        return yield* getStatementResult({ Id: id });
      });

      const query = Effect.fn(
        `AWS.RedshiftData.Statements.query(${workgroup.LogicalId})`,
      )(function* (sql: string, parameters?: data.SqlParameter[]) {
        const submitted = yield* execute({ Sql: sql, Parameters: parameters });
        const id = submitted.Id!;
        // Poll until the statement reaches a terminal status. Redshift
        // Serverless typically finishes simple statements in a few seconds;
        // budget ~2.5 min (30 * 5s).
        const described = yield* describe(id).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (r) => isTerminal(r.Status),
            times: 30,
          }),
        );
        if (described.Status !== "FINISHED") {
          return yield* Effect.fail(
            new RedshiftStatementFailed({
              statementId: id,
              status: described.Status ?? "UNKNOWN",
              error: described.Error,
            }),
          );
        }
        return yield* getResult(id);
      });

      return { execute, describe, getResult, query } satisfies StatementsClient;
    });
  }),
);
