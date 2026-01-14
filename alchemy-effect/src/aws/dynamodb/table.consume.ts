import type * as lambda from "aws-lambda";
import type { Capability } from "../../capability.ts";
import type { Table } from "./table.ts";

export type TableRecord<Data> = Omit<lambda.DynamoDBRecord, "dynamodb"> & {
  dynamodb: Omit<lambda.StreamRecord, "NewImage" | "OldImage"> & {
    NewImage?: Data;
    OldImage?: Data;
  };
};

export type TableEvent<Data> = Omit<lambda.DynamoDBStreamEvent, "Records"> & {
  Records: TableRecord<Data>[];
};

export interface Consume<T = Table> extends Capability<"AWS.DynamoDB.Consume", T> {}
