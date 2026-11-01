import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface NetworkCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** Address to check, at most 400 characters. Changing it replaces the check. */
  address: string;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface NetworkCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Address to check. */
  address: string;
}

export type NetworkCheck = Resource<
  "Stackit.Observability.NetworkCheck",
  NetworkCheckProps,
  NetworkCheckAttributes,
  never,
  Providers
>;

/**
 * Checks that an address is reachable over the network from a `Stackit.Observability.Instance`.
 *
 * The API has no update for a check, so changing anything replaces it. It has no name
 * and no labels either: the id in state is what makes a check ours, so a check with
 * the same target that Alchemy didn't record is reported as unowned and only taken
 * over with `--adopt`. `alchemy unsafe nuke` lists every check on an instance
 * it would delete anyway, because deleting the instance takes them with it.
 *
 * ### Checking an Address
 * **Example:** Check that a port answers
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.NetworkCheck("Check", {
 *   instanceId: instance.instanceId,
 *   address: "example.com:443",
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
 * const check = yield* Stackit.Observability.NetworkCheck("Check", {
 *   instanceId: instance.instanceId,
 *   address: "example.com:8443",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const NetworkCheck = Resource<NetworkCheck>("Stackit.Observability.NetworkCheck");

export const NetworkCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    NetworkCheckProps,
    observability.NetworkCheckChildResponse,
    NetworkCheckAttributes,
    | observability.ListNetworkChecksError
    | observability.CreateNetworkCheckError
    | observability.DeleteNetworkCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability network check",
    targetProp: "address",
    attrTargetOf: (attrs) => attrs.address,
    attributes: (scope, item) => ({
      checkId: item.id,
      instanceId: scope.instanceId,
      projectId: scope.projectId,
      address: item.address,
    }),
    api: {
      list: (scope) =>
        observability
          .listNetworkChecks(scope)
          .pipe(Effect.map((response) => response.networkChecks)),
      create: (scope, props) =>
        observability
          .createNetworkCheck({
            ...scope,
            address: props.address,
          })
          .pipe(Effect.map((response) => response.networkCheck)),
      remove: (scope, id) => observability.deleteNetworkCheck({ ...scope, id }),
      targetOf: (props) => props.address,
      liveTargetOf: (item) => item.address,
    },
  });

  return Provider.succeed(NetworkCheck, {
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
