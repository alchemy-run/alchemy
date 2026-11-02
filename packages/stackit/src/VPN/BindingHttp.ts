import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { BGPFilter } from "./BGPFilter.ts";
import type { BGPFilterRule } from "./BGPFilterRule.ts";
import type { BindingScope } from "./BindingScope.ts";
import type { Connection } from "./Connection.ts";
import type { Gateway } from "./Gateway.ts";

/**
 * Shared HTTP scaffolding for VPN bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding on a single
 * gateway (see `StackitBindings`). The permissions come from the spec's
 * `x-stackit-authorization` on each operation, and each binding gets a custom role with
 * only those.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.VPN.GetGateway`. */
  tag: string;
  /** The permissions the spec names for the operation, on the project holding the resource. */
  permissions: readonly string[];
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

export const makeGatewayHttpBinding = <
  I extends { projectId: string; region: string; gatewayId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (gateway: Gateway) => ({
      projectId: gateway.projectId,
      region: gateway.region,
      gatewayId: gateway.gatewayId,
    }),
    grants: (gateway) => [StackitBindings.grantOn(gateway, { permissions: options.permissions })],
  });

export const makeConnectionHttpBinding = <
  I extends { projectId: string; region: string; gatewayId: string; connectionId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (connection: Connection) => ({
      projectId: connection.projectId,
      region: connection.region,
      gatewayId: connection.gatewayId,
      connectionId: connection.connectionId,
    }),
    grants: (connection) => [
      StackitBindings.grantOn(connection, { permissions: options.permissions }),
    ],
  });

export const makeFilterHttpBinding = <
  I extends { projectId: string; region: string; gatewayId: string; filterId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (filter: BGPFilter) => ({
      projectId: filter.projectId,
      region: filter.region,
      gatewayId: filter.gatewayId,
      filterId: filter.filterId,
    }),
    grants: (filter) => [StackitBindings.grantOn(filter, { permissions: options.permissions })],
  });

export const makeRuleHttpBinding = <
  I extends {
    projectId: string;
    region: string;
    gatewayId: string;
    filterId: string;
    ruleId: string;
  },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (rule: BGPFilterRule) => ({
      projectId: rule.projectId,
      region: rule.region,
      gatewayId: rule.gatewayId,
      filterId: rule.filterId,
      ruleId: rule.ruleId,
    }),
    grants: (rule) => [StackitBindings.grantOn(rule, { permissions: options.permissions })],
  });

/** A binding on the whole project and region of the bound resource. */
export const makeScopeHttpBinding = <I extends { projectId: string; region: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({
      projectId: scope.projectId,
      region: scope.region,
    }),
    grants: (scope) => [StackitBindings.grantOn(scope, { permissions: options.permissions })],
  });

/**
 * A binding with no target and no role: the spec names no permission for the operation, so
 * the host only needs an identity to sign with.
 */
export const makeUnscopedHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.VPN.ListPlans`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({ grants: [] });
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* run(request);
      });
    });
  });
