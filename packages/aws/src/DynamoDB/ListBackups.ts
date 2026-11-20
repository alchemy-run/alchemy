import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface ListBackupsRequest extends Omit<DynamoDB.ListBackupsInput, "TableName"> {}

/**
 * Runtime binding for `dynamodb:ListBackups`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that lists the bound table's on-demand backups, automatically injecting the
 * table name. Provide the `ListBackupsHttp` layer on the Function to satisfy
 * the binding.
 * ### Backup and Restore
 * **Example:** List the Bound Table's Backups
 * ```typescript
 * const listBackups = yield* AWS.DynamoDB.ListBackups(table);
 *
 * const response = yield* listBackups();
 * const backups = response.BackupSummaries;
 * ```
 *
 * @binding
 */
export interface ListBackups extends Binding.Service<
  ListBackups,
  "AWS.DynamoDB.ListBackups",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: ListBackupsRequest,
    ) => Effect.Effect<DynamoDB.ListBackupsOutput, DynamoDB.ListBackupsError>
  >
> {}
export const ListBackups = Binding.Service<ListBackups>("AWS.DynamoDB.ListBackups");

export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.ListBackups",
    operation: DynamoDB.listBackups,
    actions: ["dynamodb:ListBackups"],
    // ListBackups does not support resource-level permissions (the runtime
    // callable still scopes results to the bound table via TableName).
    resources: () => ["*"],
  }),
);
