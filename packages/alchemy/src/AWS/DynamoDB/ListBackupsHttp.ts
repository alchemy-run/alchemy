import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.ListBackups",
    operation: DynamoDB.listBackups,
    actions: ["dynamodb:ListBackups"],
  }),
);
