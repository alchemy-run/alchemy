import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeWafv2WebAclHttpBinding } from "./BindingHttp.ts";
import type { WebACL } from "./WebACL.ts";

export interface ListResourcesForWebACLRequest extends Omit<
  WAFV2.ListResourcesForWebACLRequest,
  "WebACLArn"
> {}

/**
 * Runtime binding for `wafv2:ListResourcesForWebACL` — list the regional
 * resources (ALBs, API Gateway stages, AppSync APIs, ...) associated with
 * the bound {@link WebACL}; the web ACL ARN is injected automatically.
 *
 * Provide `WAFv2.ListResourcesForWebACLHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * ### Inspecting Associations
 * **Example:** List Protected Resources
 * ```typescript
 * // init — grants wafv2:ListResourcesForWebACL on the web ACL
 * const listResources = yield* AWS.WAFv2.ListResourcesForWebACL(acl);
 *
 * // runtime
 * const { ResourceArns } = yield* listResources();
 * ```
 *
 * @binding
 */
export interface ListResourcesForWebACL extends Binding.Service<
  ListResourcesForWebACL,
  "AWS.WAFv2.ListResourcesForWebACL",
  (
    webAcl: WebACL,
  ) => Effect.Effect<
    (
      request?: ListResourcesForWebACLRequest,
    ) => Effect.Effect<WAFV2.ListResourcesForWebACLResponse, WAFV2.ListResourcesForWebACLError>
  >
> {}

export const ListResourcesForWebACL = Binding.Service<ListResourcesForWebACL>(
  "AWS.WAFv2.ListResourcesForWebACL",
);

export const ListResourcesForWebACLHttp = Layer.effect(
  ListResourcesForWebACL,
  makeWafv2WebAclHttpBinding({
    tag: "AWS.WAFv2.ListResourcesForWebACL",
    operation: wafv2.listResourcesForWebACL,
    actions: ["wafv2:ListResourcesForWebACL"],
    inject: (acl) => ({ WebACLArn: acl.arn }),
  }),
);
