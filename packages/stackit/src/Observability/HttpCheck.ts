import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface HttpCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** URL to probe, at most 400 characters. Changing it replaces the check. */
  url: string;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface HttpCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** URL to probe. */
  url: string;
}

export type HttpCheck = Resource<
  "Stackit.Observability.HttpCheck",
  HttpCheckProps,
  HttpCheckAttributes,
  never,
  Providers
>;

/**
 * Probes a URL over HTTP from a `Stackit.Observability.Instance`.
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
 * ### Probing a URL
 * **Example:** Check that a page answers
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.HttpCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "https://example.com/health",
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
 * const check = yield* Stackit.Observability.HttpCheck("Check", {
 *   instanceId: instance.instanceId,
 *   url: "https://example.com/ready",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const HttpCheck = Resource<HttpCheck>("Stackit.Observability.HttpCheck");

export const HttpCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    HttpCheckProps,
    observability.HttpCheckChildResponse,
    HttpCheckAttributes,
    | observability.ListHttpChecksError
    | observability.CreateHttpCheckError
    | observability.DeleteHttpCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability HTTP check",
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
        observability.listHttpChecks(scope).pipe(Effect.map((response) => response.httpChecks)),
      create: (scope, props) =>
        observability
          .createHttpCheck({
            ...scope,
            url: props.url,
          })
          .pipe(Effect.map((response) => response.httpCheck)),
      remove: (scope, id) => observability.deleteHttpCheck({ ...scope, id }),
      targetOf: (props) => props.url,
      liveTargetOf: (item) => item.url,
    },
  });

  return Provider.succeed(HttpCheck, {
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
