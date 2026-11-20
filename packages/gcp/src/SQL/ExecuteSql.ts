import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Instance } from "./Instance.ts";

export interface ExecuteSqlRequest extends Omit<
  sqladmin.ExecuteSqlInstancesRequest,
  "instance" | "project"
> {}

/**
 * Runtime binding for Cloud SQL `instances.executeSql`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link ExecuteSqlHttp}. The instance must allow the
 * Execute SQL API (`dataApiAccess: true`).
 *
 * Grants `roles/cloudsql.instanceUser` (`cloudsql.instances.executeSql`,
 * `get`, `login`) on the project under an IAM Condition naming only this
 * instance.
 *
 * ### Executing SQL
 * **Example:** Run a statement
 * ```typescript
 * const executeSql = yield* GCP.SQL.ExecuteSql(db);
 * const result = yield* executeSql({
 *   body: {
 *     sqlStatement: "SELECT 1",
 *     database: "mysql",
 *     user: "root",
 *   },
 * });
 * ```
 *
 * @binding
 * @category SQL
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "GCP.SQL.ExecuteSql",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<
      sqladmin.SqlInstancesExecuteSqlResponse,
      sqladmin.ExecuteSqlInstancesError,
      RuntimeContext
    >
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("GCP.SQL.ExecuteSql");

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * @layer
 * @provides GCP.SQL.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const execute = yield* GCPBindings.withCredentials(sqladmin.executeSqlInstances);
    return Effect.fn(function* (instance: Instance) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.SQL.ExecuteSql(${instance})`({
          // Cloud SQL has no instance-level IAM policy; an IAM Condition
          // scopes the project grant to this instance.
          iam: [
            grantFor(
              { role: "roles/cloudsql.instanceUser", scopeByCondition: true },
              Output.interpolate`projects/${instance.project}/instances/${instance.instanceName}`,
            ),
          ],
        });
      }
      const instanceName = yield* instance.instanceName;
      const project = yield* instance.project;
      return Effect.fn(`GCP.SQL.ExecuteSql(${instance.LogicalId})`)(function* (
        request: ExecuteSqlRequest,
      ) {
        return yield* execute({
          ...request,
          instance: yield* instanceName,
          project: yield* project,
        });
      });
    });
  }),
);
