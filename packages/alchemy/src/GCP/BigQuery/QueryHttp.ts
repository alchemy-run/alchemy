import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Dataset } from "./Dataset.ts";
import { Query, type QueryRequest } from "./Query.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link Query}.
 *
 * @layer
 * @provides GCP.BigQuery.Query
 */
export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    const queryJobs = yield* bigquery.queryJobs;
    return Effect.fn(function* (dataset: Dataset) {
      yield* bindGcpHost({
        tag: "GCP.BigQuery.Query",
        resource: dataset,
        iam: [
          // bigquery.jobs.create is only grantable on the project.
          { role: "roles/bigquery.jobUser" },
          // Datasets have no resource kind in the IAM registry, so read
          // access is granted project-wide.
          { role: "roles/bigquery.dataViewer" },
        ],
      });
      const project = yield* dataset.project;
      const datasetId = yield* dataset.datasetId;
      const location = yield* dataset.location;
      return Effect.fn(`GCP.BigQuery.Query(${dataset.LogicalId})`)(function* (
        request: QueryRequest,
      ) {
        return yield* queryJobs({
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
        });
      });
    });
  }),
);
