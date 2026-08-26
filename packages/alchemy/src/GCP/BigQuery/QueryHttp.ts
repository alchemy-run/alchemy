import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Dataset } from "./Dataset.ts";
import { Query, type QueryRequest } from "./Query.ts";

/**
 * HTTP implementation of {@link Query}.
 *
 * @layer
 * @provides GCP.BigQuery.Query
 */
export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (dataset: Dataset) {
      const project = yield* dataset.project;
      const datasetId = yield* dataset.datasetId;
      const location = yield* dataset.location;
      return Effect.fn(`GCP.BigQuery.Query(${dataset.LogicalId})`)(function* (
        request: QueryRequest,
      ) {
        return yield* bigquery
          .queryJobs({
            projectId: yield* project,
            body: {
              useLegacySql: false,
              location: yield* location,
              ...request,
              defaultDataset: request.defaultDataset ?? {
                projectId: yield* project,
                datasetId: yield* datasetId,
              },
            },
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
