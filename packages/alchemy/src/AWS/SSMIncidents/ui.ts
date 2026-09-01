import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ReplicationSet } from "./ReplicationSet.ts";
import type { ResponsePlan } from "./ResponsePlan.ts";

/**
 * Dashboard UI providers for AWS SSMIncidents resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance / Observability (Incident Manager) brand pink. */
const COLOR = "#E7157B";

export const ReplicationSetUI = UIProvider.succeed<ReplicationSet>(
  "AWS.SSMIncidents.ReplicationSet",
  {
    displayName: "Incident Manager Replication Set",
    icon: "share-2",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.arn,
    facts: (ctx) => [
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "regions",
        value: ctx.attrs?.regionNames?.length
          ? ctx.attrs.regionNames.join(", ")
          : undefined,
      },
      { label: "deletion protected", value: ctx.attrs?.deletionProtected },
    ],
  },
);

export const ResponsePlanUI = UIProvider.succeed<ResponsePlan>(
  "AWS.SSMIncidents.ResponsePlan",
  {
    displayName: "Incident Manager Response Plan",
    icon: "alert-triangle",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "display name", value: ctx.props?.displayName },
      { label: "title", value: ctx.props?.incidentTemplate?.title },
      { label: "impact", value: ctx.props?.incidentTemplate?.impact },
    ],
  },
);

export const ui = () => Layer.mergeAll(ReplicationSetUI, ResponsePlanUI);
