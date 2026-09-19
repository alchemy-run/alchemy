import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Table } from "./Table.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for BigQuery table bindings.
 * NOT exported from index.ts.
 */
export const makeTableHttpBinding = <
  I extends { projectId: string; datasetId: string; tableId: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (table: Table) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: table,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const project = yield* table.project;
      const datasetId = yield* table.datasetId;
      const tableId = yield* table.tableId;
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "datasetId" | "tableId">,
      ) {
        return yield* run({
          ...request,
          projectId: yield* project,
          datasetId: yield* datasetId,
          tableId: yield* tableId,
        } as I);
      });
    });
  });
