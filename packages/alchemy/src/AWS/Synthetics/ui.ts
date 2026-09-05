import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Canary } from "./Canary.ts";
import type { Group } from "./Group.ts";

/**
 * Dashboard UI providers for AWS Synthetics resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const CanaryUI = UIProvider.succeed<Canary>("AWS.Synthetics.Canary", {
  displayName: "Synthetics Canary",
  icon: "test-tube",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.canaryName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.canaryName, copy: true },
    { label: "id", value: ctx.attrs?.canaryId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.canaryArn, mono: true, copy: true },
    { label: "runtime", value: ctx.attrs?.runtimeVersion },
    {
      label: "artifacts",
      value: ctx.attrs?.artifactS3Location,
      mono: true,
    },
    { label: "role", value: ctx.attrs?.executionRoleArn, mono: true },
  ],
});

export const GroupUI = UIProvider.succeed<Group>("AWS.Synthetics.Group", {
  displayName: "Synthetics Group",
  icon: "boxes",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.groupName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.groupName, copy: true },
    { label: "id", value: ctx.attrs?.groupId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.groupArn, mono: true, copy: true },
    {
      label: "members",
      value: ctx.props?.members?.length,
    },
  ],
});

export const ui = () => Layer.mergeAll(CanaryUI, GroupUI);
