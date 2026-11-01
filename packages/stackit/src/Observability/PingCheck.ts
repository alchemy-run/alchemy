import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface PingCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** Domain to ping, at most 400 characters. Changing it replaces the check. */
  url: string;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface PingCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Domain to ping. */
  url: string;
}

export type PingCheck = Resource<
  "Stackit.Observability.PingCheck",
  PingCheckProps,
  PingCheckAttributes,
  never,
  Providers
>;

/**
 * Pings a domain from a `Stackit.Observability.Instance`.
 *
 * The API has no update for a check, so changing anything replaces it. It has no name
 * and no labels either: the id in state is what makes a check ours, so a check with
 * the same target that Alchemy didn't record is reported as unowned and only taken
 * over with `--adopt`. `alchemy unsafe nuke` lists every check on an instance
 * it would delete anyway, because deleting the instance takes them with it.
 *
 * ### Pinging a Domain
 * **Example:** Ping a domain
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.PingCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "example.com",
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
 * const check = yield* Stackit.Observability.PingCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "api.example.com",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const PingCheck = Resource<PingCheck>("Stackit.Observability.PingCheck");

export const PingCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    PingCheckProps,
    observability.HttpCheckChildResponse,
    PingCheckAttributes,
    | observability.ListPingChecksError
    | observability.CreatePingCheckError
    | observability.DeletePingCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability ping check",
    targetProp: "url",
    attrTargetOf: (attrs) => attrs.url,
    attributes: (scope, item) => ({
      checkId: item.id,
      instanceId: scope.instanceId,
      projectId: scope.projectId,
      url: item.url,
    }),
    api: {
      list: (scope) =>
        observability.listPingChecks(scope).pipe(Effect.map((response) => response.pingChecks)),
      create: (scope, props) =>
        observability
          .createPingCheck({
            ...scope,
            url: props.url,
          })
          .pipe(Effect.map((response) => response.pingCheck)),
      remove: (scope, id) => observability.deletePingCheck({ ...scope, id }),
      targetOf: (props) => props.url,
      liveTargetOf: (item) => item.url,
    },
  });

  return Provider.succeed(PingCheck, {
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
