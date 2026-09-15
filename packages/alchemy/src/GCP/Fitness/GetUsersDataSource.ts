import type * as fitness from "@distilled.cloud/gcp/fitness_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { UsersDataSource } from "./UsersDataSource.ts";

export interface GetUsersDataSourceRequest extends Omit<
  fitness.GetUsersDataSourcesRequest,
  "userId" | "dataSourceId"
> {}

/**
 * Runtime binding for Fitness `users.dataSources.get`.
 *
 * Bind this operation to a {@link UsersDataSource} in a Function/Action
 * init phase. Provide {@link GetUsersDataSourceHttp}.
 *
 * ### Reading Data Sources
 * **Example:** Read data source metadata
 * ```typescript
 * const getSource = yield* GCP.Fitness.GetUsersDataSource(source);
 * const metadata = yield* getSource({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Fitness
 */
export interface GetUsersDataSource extends Binding.Service<
  GetUsersDataSource,
  "GCP.Fitness.GetUsersDataSource",
  (
    source: UsersDataSource,
  ) => Effect.Effect<
    (
      request: GetUsersDataSourceRequest,
    ) => Effect.Effect<
      fitness.DataSource,
      fitness.GetUsersDataSourcesError,
      RuntimeContext
    >
  >
> {}

export const GetUsersDataSource = Binding.Service<GetUsersDataSource>(
  "GCP.Fitness.GetUsersDataSource",
);
