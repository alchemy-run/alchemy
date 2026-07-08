import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableToPointInTimeRequest extends Omit<
  DynamoDB.RestoreTableToPointInTimeInput,
  "SourceTableArn" | "SourceTableName" | "TargetTableName"
> {}

/** @binding */
export interface RestoreTableToPointInTime extends Binding.Service<
  RestoreTableToPointInTime,
  "AWS.DynamoDB.RestoreTableToPointInTime",
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<
    (
      request: RestoreTableToPointInTimeRequest,
    ) => Effect.Effect<
      DynamoDB.RestoreTableToPointInTimeOutput,
      DynamoDB.RestoreTableToPointInTimeError
    >
  >
> {}

export const RestoreTableToPointInTime =
  Binding.Service<RestoreTableToPointInTime>(
    "AWS.DynamoDB.RestoreTableToPointInTime",
  );
