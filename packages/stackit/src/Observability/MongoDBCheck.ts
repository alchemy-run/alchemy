import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface MongoDBCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** URL of the MongoDB server to check, at most 200 characters. Changing it replaces the check. */
  server: string;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface MongoDBCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** URL of the MongoDB server to check. */
  server: string;
}

export type MongoDBCheck = Resource<
  "Stackit.Observability.MongoDBCheck",
  MongoDBCheckProps,
  MongoDBCheckAttributes,
  never,
  Providers
>;

/**
 * Watches a MongoDB server from a `Stackit.Observability.Instance`.
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
 * ### Watching MongoDB
 * **Example:** Check a MongoDB server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.MongoDBCheck("Check", {
 *   instanceId: instance.instanceId,
 *   server: "mongodb://db.example.com:27017",
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
 * const check = yield* Stackit.Observability.MongoDBCheck("Check", {
 *   instanceId: instance.instanceId,
 *   server: "mongodb://db2.example.com:27017",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const MongoDBCheck = Resource<MongoDBCheck>("Stackit.Observability.MongoDBCheck");

export const MongoDBCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    MongoDBCheckProps,
    observability.MongodbCheckChildResponse,
    MongoDBCheckAttributes,
    | observability.ListMongodbChecksError
    | observability.CreateMongodbCheckError
    | observability.DeleteMongodbCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability MongoDB check",
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
        observability
          .listMongodbChecks(scope)
          .pipe(Effect.map((response) => response.mongodbChecks)),
      create: (scope, props) =>
        observability
          .createMongodbCheck({
            ...scope,
            server: props.server,
          })
          .pipe(Effect.map((response) => response.mongodbCheck)),
      remove: (scope, id) => observability.deleteMongodbCheck({ ...scope, id }),
      targetOf: (props) => props.server,
      liveTargetOf: (item) => item.server,
    },
  });

  return Provider.succeed(MongoDBCheck, {
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
