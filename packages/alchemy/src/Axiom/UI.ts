import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Annotation } from "./Annotation.ts";
import type { ApiToken } from "./ApiToken.ts";
import type { Dashboard } from "./Dashboard.ts";
import type { Dataset } from "./Dataset.ts";
import type { Monitor } from "./Monitor.ts";
import type { Notifier } from "./Notifier.ts";
import type { View } from "./View.ts";
import type { VirtualField } from "./VirtualField.ts";

/**
 * Dashboard UI providers for Axiom resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Axiom SDK code reaches the dashboard bundle.
 */

const AXIOM_BLUE = "#3b82f6";

export const DatasetUI = UIProvider.succeed<Dataset>("Axiom.Dataset", {
  displayName: "Axiom Dataset",
  icon: "database",
  color: AXIOM_BLUE,
  category: "observability",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name ?? ctx.props?.name, copy: true },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "kind", value: ctx.attrs?.kind ?? ctx.props?.kind },
    {
      label: "retention",
      value:
        ctx.props?.retentionDays === undefined
          ? undefined
          : `${ctx.props.retentionDays}d`,
    },
    {
      label: "otel endpoint",
      value: ctx.attrs?.otelEndpoint,
      mono: true,
      copy: true,
    },
    { label: "created", value: ctx.attrs?.created },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const DashboardUI = UIProvider.succeed<Dashboard>("Axiom.Dashboard", {
  displayName: "Axiom Dashboard",
  icon: "layout-dashboard",
  color: AXIOM_BLUE,
  category: "observability",
  summary: (ctx) =>
    ctx.attrs?.dashboard?.name ?? ctx.props?.dashboard?.name ?? ctx.attrs?.uid,
  facts: (ctx) => [
    {
      label: "name",
      value: ctx.attrs?.dashboard?.name ?? ctx.props?.dashboard?.name,
    },
    { label: "uid", value: ctx.attrs?.uid, mono: true, copy: true },
    {
      label: "charts",
      value: ctx.props?.dashboard?.charts?.length,
    },
    {
      label: "refresh",
      value:
        ctx.props?.dashboard?.refreshTime === undefined
          ? undefined
          : `${ctx.props.dashboard.refreshTime}s`,
    },
    {
      label: "window",
      value:
        ctx.props?.dashboard?.timeWindowStart === undefined
          ? undefined
          : `${ctx.props.dashboard.timeWindowStart} → ${ctx.props.dashboard.timeWindowEnd ?? ""}`,
    },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const MonitorUI = UIProvider.succeed<Monitor>("Axiom.Monitor", {
  displayName: "Axiom Monitor",
  icon: "activity",
  color: AXIOM_BLUE,
  category: "observability",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type ?? ctx.props?.type },
    {
      label: "interval",
      value:
        (ctx.attrs?.intervalMinutes ?? ctx.props?.intervalMinutes) === undefined
          ? undefined
          : `${ctx.attrs?.intervalMinutes ?? ctx.props?.intervalMinutes}m`,
    },
    {
      label: "threshold",
      value:
        ctx.attrs?.threshold === undefined
          ? undefined
          : `${ctx.attrs?.operator ?? ""} ${ctx.attrs.threshold}`.trim(),
    },
    {
      label: "notifiers",
      value: (ctx.attrs?.notifierIds ?? ctx.props?.notifierIds)?.length,
    },
    { label: "disabled", value: ctx.attrs?.disabled },
  ],
});

export const NotifierUI = UIProvider.succeed<Notifier>("Axiom.Notifier", {
  displayName: "Axiom Notifier",
  icon: "bell-ring",
  color: AXIOM_BLUE,
  category: "observability",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    {
      label: "channel",
      value: Object.keys(
        ctx.attrs?.properties ?? ctx.props?.properties ?? {},
      )[0],
    },
    { label: "created", value: ctx.attrs?.createdAt },
    { label: "updated", value: ctx.attrs?.updatedAt },
  ],
});

export const ApiTokenUI = UIProvider.succeed<ApiToken>("Axiom.ApiToken", {
  displayName: "Axiom API Token",
  icon: "key-round",
  color: AXIOM_BLUE,
  category: "auth",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    {
      label: "datasets",
      value:
        ctx.attrs?.datasetCapabilities === undefined
          ? undefined
          : Object.keys(ctx.attrs.datasetCapabilities).join(", "),
    },
    { label: "expires", value: ctx.attrs?.expiresAt ?? undefined },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const ViewUI = UIProvider.succeed<View>("Axiom.View", {
  displayName: "Axiom View",
  icon: "bookmark",
  color: AXIOM_BLUE,
  category: "observability",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name ?? ctx.props?.name, copy: true },
    {
      label: "datasets",
      value: (ctx.attrs?.datasets ?? ctx.props?.datasets)?.join(", "),
    },
    {
      label: "query",
      value: ctx.attrs?.aplQuery ?? ctx.props?.aplQuery,
      mono: true,
      copy: true,
    },
    { label: "description", value: ctx.attrs?.description },
  ],
});

export const VirtualFieldUI = UIProvider.succeed<VirtualField>(
  "Axiom.VirtualField",
  {
    displayName: "Axiom Virtual Field",
    icon: "sigma",
    color: AXIOM_BLUE,
    category: "observability",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name ?? ctx.props?.name },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "dataset", value: ctx.attrs?.dataset ?? ctx.props?.dataset },
      {
        label: "expression",
        value: ctx.attrs?.expression ?? ctx.props?.expression,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type ?? ctx.props?.type },
      { label: "unit", value: ctx.attrs?.unit ?? ctx.props?.unit },
    ],
  },
);

export const AnnotationUI = UIProvider.succeed<Annotation>("Axiom.Annotation", {
  displayName: "Axiom Annotation",
  icon: "flag",
  color: AXIOM_BLUE,
  category: "observability",
  summary: (ctx) =>
    ctx.attrs?.title ?? ctx.props?.title ?? ctx.attrs?.type ?? ctx.props?.type,
  link: (ctx) => ctx.attrs?.url ?? ctx.props?.url,
  facts: (ctx) => [
    { label: "title", value: ctx.attrs?.title ?? ctx.props?.title },
    { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type ?? ctx.props?.type },
    {
      label: "datasets",
      value: (ctx.attrs?.datasets ?? ctx.props?.datasets)?.join(", "),
    },
    { label: "time", value: ctx.attrs?.time ?? ctx.props?.time },
    {
      label: "end",
      value: (ctx.attrs?.endTime ?? ctx.props?.endTime) || undefined,
    },
    {
      label: "url",
      value: ctx.attrs?.url ?? ctx.props?.url,
      href: ctx.attrs?.url ?? ctx.props?.url,
    },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    DatasetUI,
    DashboardUI,
    MonitorUI,
    NotifierUI,
    ApiTokenUI,
    ViewUI,
    VirtualFieldUI,
    AnnotationUI,
  );
