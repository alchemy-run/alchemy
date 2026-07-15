import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ListResolverRuleAssociations } from "./ListResolverRuleAssociations.ts";
import type { ResolverRule } from "./ResolverRule.ts";

/**
 * Bespoke (not via `BindingHttp.ts`): the operation is filter-based rather
 * than ID-keyed, so the rule is injected as a `ResolverRuleId` filter instead
 * of a request field.
 */
export const ListResolverRuleAssociationsHttp = Layer.effect(
  ListResolverRuleAssociations,
  Effect.gen(function* () {
    const op = yield* r53r.listResolverRuleAssociations;

    return Effect.fn(function* (rule: ResolverRule) {
      const ResolverRuleId = yield* rule.resolverRuleId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Route53Resolver.ListResolverRuleAssociations(${rule}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["route53resolver:ListResolverRuleAssociations"],
                  Resource: [rule.resolverRuleArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Route53Resolver.ListResolverRuleAssociations(${rule.LogicalId})`,
      )(function* (
        request?: Omit<r53r.ListResolverRuleAssociationsRequest, "Filters">,
      ) {
        return yield* op({
          ...request,
          Filters: [
            { Name: "ResolverRuleId", Values: [yield* ResolverRuleId] },
          ],
        });
      });
    });
  }),
);
