import * as r53r from "@distilled.cloud/aws/route53resolver";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { ResolverRule } from "./ResolverRule.ts";

export interface ListResolverRuleAssociationsRequest extends Omit<
  r53r.ListResolverRuleAssociationsRequest,
  "Filters"
> {}

/**
 * Runtime binding for `route53resolver:ListResolverRuleAssociations` —
 * enumerate the VPC associations of the bound {@link ResolverRule}. The
 * request is automatically filtered to the bound rule
 * (`Filters: [{ Name: "ResolverRuleId", … }]`).
 *
 * Provide `Route53Resolver.ListResolverRuleAssociationsHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * ### Reading Rule State
 * **Example:** List the VPCs a Rule Is Live In
 * ```typescript
 * // init — grants route53resolver:ListResolverRuleAssociations on the rule
 * const listAssociations = yield* AWS.Route53Resolver.ListResolverRuleAssociations(rule);
 *
 * // runtime
 * const { ResolverRuleAssociations } = yield* listAssociations();
 * const vpcIds = (ResolverRuleAssociations ?? []).map((a) => a.VPCId);
 * ```
 *
 * @binding
 */
export interface ListResolverRuleAssociations extends Binding.Service<
  ListResolverRuleAssociations,
  "AWS.Route53Resolver.ListResolverRuleAssociations",
  (
    rule: ResolverRule,
  ) => Effect.Effect<
    (
      request?: ListResolverRuleAssociationsRequest,
    ) => Effect.Effect<
      r53r.ListResolverRuleAssociationsResponse,
      r53r.ListResolverRuleAssociationsError
    >
  >
> {}

export const ListResolverRuleAssociations = Binding.Service<ListResolverRuleAssociations>(
  "AWS.Route53Resolver.ListResolverRuleAssociations",
);

/**
 * Bespoke (not via `BindingHttp.ts`): the operation is filter-based rather
 * than ID-keyed, so the rule is injected as a `ResolverRuleId` filter instead
 * of a request field. The IAM grant is `Resource: "*"` — verified live:
 * `route53resolver:ListResolverRuleAssociations` does not support
 * resource-level permissions (a rule-ARN-scoped grant is AccessDenied), the
 * runtime callable's injected filter is what scopes results to the bound
 * rule. The operation also internally describes the associated VPCs, so
 * `ec2:DescribeVpcs` is required alongside it (also verified live — without
 * it the call fails with `InvalidParameterException: You are not authorized
 * to perform this operation ... ec2:DescribeVpcs`).
 */
export const ListResolverRuleAssociationsHttp = Layer.effect(
  ListResolverRuleAssociations,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(r53r.listResolverRuleAssociations);

    return Effect.fn(function* (rule: ResolverRule) {
      const ResolverRuleId = yield* rule.resolverRuleId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Route53Resolver.ListResolverRuleAssociations(${rule})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["route53resolver:ListResolverRuleAssociations", "ec2:DescribeVpcs"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Route53Resolver.ListResolverRuleAssociations(${rule.LogicalId})`)(
        function* (request?: Omit<r53r.ListResolverRuleAssociationsRequest, "Filters">) {
          return yield* op({
            ...request,
            Filters: [{ Name: "ResolverRuleId", Values: [yield* ResolverRuleId] }],
          });
        },
      );
    });
  }),
);
