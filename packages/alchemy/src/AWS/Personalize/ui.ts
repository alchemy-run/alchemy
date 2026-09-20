import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Dataset } from "./Dataset.ts";
import type { DatasetGroup } from "./DatasetGroup.ts";
import type { EventTracker } from "./EventTracker.ts";
import type { Schema } from "./Schema.ts";

/**
 * Dashboard UI providers for AWS Personalize resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Machine Learning & AI (Personalize) brand teal. */
const COLOR = "#01A88D";

export const DatasetGroupUI = UIProvider.succeed<DatasetGroup>(
  "AWS.Personalize.DatasetGroup",
  {
    displayName: "Personalize Dataset Group",
    icon: "boxes",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.datasetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "domain", value: ctx.attrs?.domain },
    ],
  },
);

export const DatasetUI = UIProvider.succeed<Dataset>(
  "AWS.Personalize.Dataset",
  {
    displayName: "Personalize Dataset",
    icon: "table",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "dataset", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.datasetArn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.datasetType },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "dataset group",
        value: ctx.attrs?.datasetGroupArn,
        mono: true,
      },
      { label: "schema", value: ctx.attrs?.schemaArn, mono: true },
    ],
  },
);

export const SchemaUI = UIProvider.succeed<Schema>("AWS.Personalize.Schema", {
  displayName: "Personalize Schema",
  icon: "file-text",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "schema", value: ctx.attrs?.name, copy: true },
    { label: "arn", value: ctx.attrs?.schemaArn, mono: true, copy: true },
    { label: "domain", value: ctx.attrs?.domain },
  ],
});

export const EventTrackerUI = UIProvider.succeed<EventTracker>(
  "AWS.Personalize.EventTracker",
  {
    displayName: "Personalize Event Tracker",
    icon: "activity",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "tracker", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.eventTrackerArn,
        mono: true,
        copy: true,
      },
      {
        label: "tracking id",
        value: ctx.attrs?.trackingId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "dataset group",
        value: ctx.attrs?.datasetGroupArn,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(DatasetGroupUI, DatasetUI, SchemaUI, EventTrackerUI);
