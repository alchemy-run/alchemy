import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { AnomalyMonitor } from "./AnomalyMonitor.ts";
import { pinCe } from "./common.ts";
import type { CostCategory } from "./CostCategory.ts";

/**
 * Shared HTTP scaffolding for the Cost Explorer runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action, and (for the
 * scoped builders) the injected ARN is boilerplate.
 *
 * Cost Explorer is a global service served exclusively from the `us-east-1`
 * endpoint, so every operation is resolved with the Region pinned via
 * {@link pinCe} — exactly like the resource providers in `common.ts`.
 *
 * Most `ce:` query actions do not support resource-level permissions, so the
 * account-level builder grants on `Resource: ["*"]`. The anomaly-monitor and
 * cost-category builders grant on the bound resource's ARN (those actions
 * authorize on the `anomalymonitor` / `costcategory` resource types).
 */

/**
 * Build the impl Effect for an account-level Cost Explorer operation (the
 * cost/usage queries, forecasts, recommendations, and cost allocation tag
 * operations — none of which are resource-scoped).
 */
export const makeCostExplorerHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetCostAndUsage"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinCe(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CostExplorer.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CostExplorer.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation scoped to one
 * {@link AnomalyMonitor}. The runtime callable injects the bound monitor's
 * ARN as the request's `MonitorArn`; the deploy-time half grants
 * `iamActions` on the monitor's ARN.
 */
export const makeAnomalyMonitorHttpBinding = <
  I extends { MonitorArn?: string },
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetAnomalies"`.
   */
  capability: string;
  /** IAM actions granted on the monitor ARN. */
  iamActions: readonly string[];
  /** The distilled operation; `MonitorArn` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinCe(options.operation);

    return Effect.fn(function* (monitor: AnomalyMonitor) {
      const MonitorArn = yield* monitor.monitorArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grantOnMonitor(options.capability, options.iamActions, monitor);
      }
      return Effect.fn(
        `AWS.CostExplorer.${options.capability}(${monitor.LogicalId})`,
      )(function* (request: Omit<I, "MonitorArn">) {
        return yield* op({
          ...request,
          MonitorArn: yield* MonitorArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation whose IAM authorization is scoped
 * to one {@link AnomalyMonitor} but whose request carries no `MonitorArn`
 * (e.g. `ProvideAnomalyFeedback`, which addresses an anomaly by id — the
 * action authorizes on the anomaly's monitor). The request passes through
 * untouched; the deploy-time half grants `iamActions` on the monitor's ARN.
 */
export const makeAnomalyMonitorGrantHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ProvideAnomalyFeedback"`.
   */
  capability: string;
  /** IAM actions granted on the monitor ARN. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinCe(options.operation);

    return Effect.fn(function* (monitor: AnomalyMonitor) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grantOnMonitor(options.capability, options.iamActions, monitor);
      }
      return Effect.fn(
        `AWS.CostExplorer.${options.capability}(${monitor.LogicalId})`,
      )(function* (request: I) {
        return yield* op(request);
      });
    });
  });

const grantOnMonitor = Effect.fn(function* (
  capability: string,
  iamActions: readonly string[],
  monitor: AnomalyMonitor,
) {
  const host = yield* Binding.Host;
  if (isBindingHost(host)) {
    yield* host.bind`Allow(${host}, AWS.CostExplorer.${capability}(${monitor}))`(
      {
        policyStatements: [
          {
            Effect: "Allow",
            Action: [...iamActions],
            Resource: [monitor.monitorArn],
          },
        ],
      },
    );
  }
});

/**
 * Build the impl Effect for an operation scoped to one {@link CostCategory}.
 * The runtime callable injects the bound category's ARN as the request's
 * `CostCategoryArn`; the deploy-time half grants `iamActions` on the
 * category's ARN.
 */
export const makeCostCategoryHttpBinding = <
  I extends { CostCategoryArn?: string },
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListCostCategoryResourceAssociations"`.
   */
  capability: string;
  /** IAM actions granted on the cost category ARN. */
  iamActions: readonly string[];
  /** The distilled operation; `CostCategoryArn` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinCe(options.operation);

    return Effect.fn(function* (category: CostCategory) {
      const CostCategoryArn = yield* category.costCategoryArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CostExplorer.${options.capability}(${category}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [category.costCategoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.CostExplorer.${options.capability}(${category.LogicalId})`,
      )(function* (request?: Omit<I, "CostCategoryArn">) {
        return yield* op({
          ...request,
          CostCategoryArn: yield* CostCategoryArn,
        } as I);
      });
    });
  });
