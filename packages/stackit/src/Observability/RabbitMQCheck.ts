import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface RabbitMQCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** URL of the RabbitMQ broker to check, at most 200 characters. Changing it replaces the check. */
  url: string;
  /** Username to log in to the target with. Changing it replaces the check. */
  username?: string;
  /** Password to log in to the target with. Changing it replaces the check. */
  password?: string | Redacted.Redacted<string>;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface RabbitMQCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** URL of the RabbitMQ broker to check. */
  url: string;
  /** Username the check logs in with. The password stays out of the attributes. */
  username: string | undefined;
}

export type RabbitMQCheck = Resource<
  "Stackit.Observability.RabbitMQCheck",
  RabbitMQCheckProps,
  RabbitMQCheckAttributes,
  never,
  Providers
>;

/**
 * Watches a RabbitMQ broker from a `Stackit.Observability.Instance`.
 *
 * The API has no update for a check, so changing anything replaces it. It has no name
 * and no labels either: the id in state is what makes a check ours, so a check with
 * the same target that Alchemy didn't record is reported as unowned and only taken
 * over with `--adopt`. The API hands the password back in plain on every list, so Alchemy never keeps it in the attributes. `alchemy unsafe nuke` lists every check on an instance
 * it would delete anyway, because deleting the instance takes them with it.
 *
 * See [STACKIT's Observability docs](https://docs.stackit.cloud/products/logging-and-monitoring/observability/).
 *
 * :::caution[Changing any prop replaces the Check]
 * The API has no update for a check. A new check is created and the old one is
 * deleted.
 * :::
 *
 * ### Watching RabbitMQ
 * **Example:** Check a RabbitMQ broker
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.RabbitMQCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "https://broker.example.com:15672",
 * });
 * ```
 *
 * **Example:** A check that logs in with a redacted config value
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const password = Config.Redacted("CHECK_PASSWORD");
 * const check = yield* Stackit.Observability.RabbitMQCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "https://broker.example.com:15672",
 *   username: "monitor",
 *   password,
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
 * const check = yield* Stackit.Observability.RabbitMQCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "https://broker2.example.com:15672",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const RabbitMQCheck = Resource<RabbitMQCheck>("Stackit.Observability.RabbitMQCheck");

export const RabbitMQCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    RabbitMQCheckProps,
    observability.RabbitMQCheckChildResponse,
    RabbitMQCheckAttributes,
    | observability.ListRabbitmqChecksError
    | observability.CreateRabbitmqCheckError
    | observability.DeleteRabbitmqCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability RabbitMQ check",
    targetProp: "url",
    attrTargetOf: (attrs) => attrs.url,
    attributes: (scope, item) => ({
      checkId: item.id,
      instanceId: scope.instanceId,
      projectId: scope.projectId,
      url: item.url,
      username: item.username,
    }),
    api: {
      list: (scope) =>
        observability
          .listRabbitmqChecks(scope)
          .pipe(Effect.map((response) => response.rabbitmqChecks)),
      create: (scope, props) =>
        observability
          .createRabbitmqCheck({
            ...scope,
            url: props.url,
            ...(props.username !== undefined ? { username: props.username } : {}),
            ...(props.password !== undefined ? { password: props.password } : {}),
          })
          .pipe(Effect.map((response) => response.rabbitmqCheck)),
      remove: (scope, id) => observability.deleteRabbitmqCheck({ ...scope, id }),
      targetOf: (props) => props.url,
      liveTargetOf: (item) => item.url,
    },
  });

  return Provider.succeed(RabbitMQCheck, {
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
