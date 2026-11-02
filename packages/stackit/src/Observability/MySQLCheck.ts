import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface MySQLCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** URL of the MySQL server to check, at most 200 characters. Changing it replaces the check. */
  server: string;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface MySQLCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** URL of the MySQL server to check. */
  server: string;
}

export type MySQLCheck = Resource<
  "Stackit.Observability.MySQLCheck",
  MySQLCheckProps,
  MySQLCheckAttributes,
  never,
  Providers
>;

/**
 * Watches a MySQL server from a `Stackit.Observability.Instance`.
 *
 * The API has no update for a check, so changing anything replaces it. It has no name
 * and no labels either: the id in state is what makes a check ours, so a check with
 * the same target that Alchemy didn't record is reported as unowned and only taken
 * over with `--adopt`. `alchemy unsafe nuke` lists every check on an instance
 * it would delete anyway, because deleting the instance takes them with it.
 *
 * See [STACKIT's Observability docs](https://docs.stackit.cloud/products/logging-and-monitoring/observability/).
 *
 * :::caution[Changing any prop replaces the Check]
 * The API has no update for a check. A new check is created and the old one is
 * deleted.
 * :::
 *
 * ### Watching MySQL
 * **Example:** Check a MySQL server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.MySQLCheck("Check", {
 *   instanceId: instance.instanceId,
 *   server: "db.example.com:3306",
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the target makes a new check
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new check is created with a new id, and the old one is deleted.
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.MySQLCheck("Check", {
 *   instanceId: instance.instanceId,
 *   server: "db2.example.com:3306",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const MySQLCheck = Resource<MySQLCheck>("Stackit.Observability.MySQLCheck");

export const MySQLCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    MySQLCheckProps,
    observability.MongodbCheckChildResponse,
    MySQLCheckAttributes,
    | observability.ListMysqlChecksError
    | observability.CreateMysqlCheckError
    | observability.DeleteMysqlCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability MySQL check",
    targetProp: "server",
    attrTargetOf: (attrs) => attrs.server,
    attributes: (scope, item) => ({
      checkId: item.id,
      instanceId: scope.instanceId,
      projectId: scope.projectId,
      server: item.server,
    }),
    api: {
      list: (scope) =>
        observability.listMysqlChecks(scope).pipe(Effect.map((response) => response.mysqlChecks)),
      create: (scope, props) =>
        observability
          .createMysqlCheck({
            ...scope,
            server: props.server,
          })
          .pipe(Effect.map((response) => response.mysqlCheck)),
      remove: (scope, id) => observability.deleteMysqlCheck({ ...scope, id }),
      targetOf: (props) => props.server,
      liveTargetOf: (item) => item.server,
    },
  });

  return Provider.succeed(MySQLCheck, {
    stables: ["checkId", "instanceId", "projectId"],
    nuke: { dependsOn: ["Stackit.Observability.Instance"] },
    list: lifecycle.list,

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      return yield* lifecycle.diff(news, olds, output);
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      return yield* lifecycle.read(olds, output, previous);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      return yield* lifecycle.reconcile(news, output);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycle.delete(output);
    }),
  });
};
