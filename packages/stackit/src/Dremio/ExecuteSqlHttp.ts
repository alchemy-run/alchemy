import * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Layer from "effect/Layer";
import { makeRestBinding } from "./BindingHttp.ts";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";

/**
 * HTTP implementation of {@link ExecuteSql}, on Dremio's REST API.
 *
 * @layer
 * @provides Stackit.Dremio.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.succeed(
  ExecuteSql,
  makeRestBinding((call) => (request: ExecuteSqlRequest) => call(rest.submitSql, request)),
);
