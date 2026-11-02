import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { makeCheckLifecycle } from "./internal/checks.ts";

export interface CertCheckProps {
  /** Id of the instance that runs the check. Changing it replaces the check. */
  instanceId: string;
  /** The certificate to check, at most 270 characters. Changing it replaces the check. */
  source: string;
  /** Project that owns the instance. Changing it replaces the check. @default the profile's project */
  projectId?: string;
}

export interface CertCheckAttributes {
  /** Id STACKIT assigned to the check. */
  checkId: string;
  /** Id of the instance that runs the check. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** The certificate to check. */
  source: string;
}

export type CertCheck = Resource<
  "Stackit.Observability.CertCheck",
  CertCheckProps,
  CertCheckAttributes,
  never,
  Providers
>;

/**
 * Watches a certificate from a `Stackit.Observability.Instance`.
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
 * ### Watching a Certificate
 * **Example:** Check the certificate of a host
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const check = yield* Stackit.Observability.CertCheck("Check", {
 *   instanceId: instance.instanceId,
 *   source: "example.com:443",
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
 * const check = yield* Stackit.Observability.CertCheck("Check", {
 *   instanceId: instance.instanceId,
 *   source: "api.example.com:443",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const CertCheck = Resource<CertCheck>("Stackit.Observability.CertCheck");

export const CertCheckProvider = () => {
  const lifecycle = makeCheckLifecycle<
    CertCheckProps,
    observability.CertCheckChildResponse,
    CertCheckAttributes,
    | observability.ListCertChecksError
    | observability.CreateCertCheckError
    | observability.DeleteCertCheckError,
    observability.StackitOpContext
  >({
    label: "STACKIT Observability certificate check",
    targetProp: "source",
    attrTargetOf: (attrs) => attrs.source,
    attributes: (scope, item) => ({
      checkId: item.id,
      instanceId: scope.instanceId,
      projectId: scope.projectId,
      source: item.source,
    }),
    api: {
      list: (scope) =>
        observability.listCertChecks(scope).pipe(Effect.map((response) => response.certChecks)),
      create: (scope, props) =>
        observability
          .createCertCheck({
            ...scope,
            source: props.source,
          })
          .pipe(Effect.map((response) => response.certCheck)),
      remove: (scope, id) => observability.deleteCertCheck({ ...scope, id }),
      targetOf: (props) => props.source,
      liveTargetOf: (item) => item.source,
    },
  });

  return Provider.succeed(CertCheck, {
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
