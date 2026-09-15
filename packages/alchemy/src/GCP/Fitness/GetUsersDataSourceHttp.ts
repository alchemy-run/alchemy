import * as fitness from "@distilled.cloud/gcp/fitness_v1";
import * as Layer from "effect/Layer";
import { makeUsersDataSourceHttpBinding } from "./BindingHttp.ts";
import { GetUsersDataSource } from "./GetUsersDataSource.ts";

/**
 * HTTP implementation of {@link GetUsersDataSource}.
 *
 * @layer
 * @provides GCP.Fitness.GetUsersDataSource
 */
export const GetUsersDataSourceHttp = Layer.effect(
  GetUsersDataSource,
  makeUsersDataSourceHttpBinding({
    tag: "GCP.Fitness.GetUsersDataSource",
    operation: fitness.getUsersDataSources,
  }),
);
