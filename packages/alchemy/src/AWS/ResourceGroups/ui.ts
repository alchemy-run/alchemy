import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Group } from "./Group.ts";

/**
 * Dashboard UI providers for AWS ResourceGroups resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const GroupUI = UIProvider.succeed<Group>("AWS.ResourceGroups.Group", {
  displayName: "Resource Group",
  icon: "boxes",
  color: "#E7157B",
  category: "config",
  summary: (ctx) => ctx.attrs?.groupName,
  facts: (ctx) => [
    { label: "group", value: ctx.attrs?.groupName, copy: true },
    { label: "arn", value: ctx.attrs?.groupArn, mono: true, copy: true },
    { label: "description", value: ctx.props?.description },
    { label: "query type", value: ctx.props?.resourceQuery?.type },
  ],
});

export const ui = () => Layer.mergeAll(GroupUI);
