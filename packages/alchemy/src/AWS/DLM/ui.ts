import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LifecyclePolicy } from "./LifecyclePolicy.ts";

/**
 * Dashboard UI providers for AWS DLM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const LifecyclePolicyUI = UIProvider.succeed<LifecyclePolicy>(
  "AWS.DLM.LifecyclePolicy",
  {
    displayName: "DLM Lifecycle Policy",
    icon: "repeat",
    color: "#7AA116",
    category: "storage",
    summary: (ctx) => ctx.attrs?.policyId,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.policyArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.state },
      { label: "type", value: ctx.props?.policyDetails?.policyType },
      { label: "role", value: ctx.attrs?.executionRoleArn, mono: true },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const ui = () => Layer.mergeAll(LifecyclePolicyUI);
