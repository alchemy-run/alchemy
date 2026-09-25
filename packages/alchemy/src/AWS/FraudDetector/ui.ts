import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Detector } from "./Detector.ts";
import type { DetectorVersion } from "./DetectorVersion.ts";
import type { EntityType } from "./EntityType.ts";
import type { EventType } from "./EventType.ts";
import type { Label } from "./Label.ts";
import type { List } from "./List.ts";
import type { Outcome } from "./Outcome.ts";
import type { Variable } from "./Variable.ts";

/**
 * Dashboard UI providers for AWS Fraud Detector resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#01A88D";

export const DetectorUI = UIProvider.succeed<Detector>(
  "AWS.FraudDetector.Detector",
  {
    displayName: "Fraud Detector",
    icon: "shield-check",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.detectorId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.detectorId, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "event type", value: ctx.attrs?.eventTypeName },
    ],
  },
);

export const DetectorVersionUI = UIProvider.succeed<DetectorVersion>(
  "AWS.FraudDetector.DetectorVersion",
  {
    displayName: "Fraud Detector Version",
    icon: "git-branch",
    color: COLOR,
    category: "ai",
    summary: (ctx) =>
      ctx.attrs?.detectorVersionId
        ? `${ctx.attrs?.detectorId ?? ""}/${ctx.attrs.detectorVersionId}`
        : ctx.attrs?.detectorId,
    facts: (ctx) => [
      { label: "detector", value: ctx.attrs?.detectorId, copy: true },
      { label: "version", value: ctx.attrs?.detectorVersionId },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const EntityTypeUI = UIProvider.succeed<EntityType>(
  "AWS.FraudDetector.EntityType",
  {
    displayName: "Fraud Detector Entity Type",
    icon: "user",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    ],
  },
);

export const EventTypeUI = UIProvider.succeed<EventType>(
  "AWS.FraudDetector.EventType",
  {
    displayName: "Fraud Detector Event Type",
    icon: "zap",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      {
        label: "variables",
        value: ctx.props?.eventVariables?.length
          ? ctx.props.eventVariables.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "entity types",
        value: ctx.props?.entityTypes?.length
          ? ctx.props.entityTypes.join(", ")
          : undefined,
      },
    ],
  },
);

export const LabelUI = UIProvider.succeed<Label>("AWS.FraudDetector.Label", {
  displayName: "Fraud Detector Label",
  icon: "tag",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
  ],
});

export const ListUI = UIProvider.succeed<List>("AWS.FraudDetector.List", {
  displayName: "Fraud Detector List",
  icon: "list-ordered",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    { label: "variable type", value: ctx.props?.variableType },
    {
      label: "elements",
      value: ctx.props?.elements?.length,
    },
  ],
});

export const OutcomeUI = UIProvider.succeed<Outcome>(
  "AWS.FraudDetector.Outcome",
  {
    displayName: "Fraud Detector Outcome",
    icon: "flag",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    ],
  },
);

export const VariableUI = UIProvider.succeed<Variable>(
  "AWS.FraudDetector.Variable",
  {
    displayName: "Fraud Detector Variable",
    icon: "table",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "data type", value: ctx.attrs?.dataType },
      { label: "data source", value: ctx.attrs?.dataSource },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    DetectorUI,
    DetectorVersionUI,
    EntityTypeUI,
    EventTypeUI,
    LabelUI,
    ListUI,
    OutcomeUI,
    VariableUI,
  );
