import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Table } from "./Table.ts";

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
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (table: Table) {
      const project = yield* table.project;
      const datasetId = yield* table.datasetId;
      const tableId = yield* table.tableId;
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "datasetId" | "tableId">,
      ) {
        return yield* options
          .operation({
            ...request,
            projectId: yield* project,
            datasetId: yield* datasetId,
            tableId: yield* tableId,
          } as I)
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  });
